const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sharp = require("sharp");
const { ArchiveService } = require("./archiveService");
const { createInitialState } = require("./appState");
const {
  entrySummaryIndexPath,
  readEntryCatalog,
  readEntrySummaryIndex,
  readMutationJournal,
  writeEntryCatalog,
  writeEntrySummaryIndex,
  writeMutationJournal
} = require("./catalogStore");

function createEmitters(overrides = {}) {
  return {
    emitShellState: () => {},
    emitProgress: () => {},
    emitEntriesInvalidated: () => {},
    ...overrides
  };
}

async function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
  } catch (_error) {
    t.skip("symlinks are not available on this platform");
    return false;
  }
  return true;
}

async function createRollbackTestFixture(tempDir, archiveName) {
  const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
  state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
  state.installStatus = {
    active: false,
    phase: "complete",
    message: "ready",
    currentTarget: null,
    completedSteps: 1,
    totalSteps: 1,
    installed: [],
    skipped: []
  };

  const service = new ArchiveService(state, createEmitters());
  await service.initialize();
  await service.createArchive({
    parentPath: tempDir,
    name: archiveName,
    password: "password",
    preferences: state.settings
  });

  return {
    archivePath: path.join(tempDir, `${archiveName}.stow`),
    service
  };
}

function stubPersistRootFailure(service) {
  const originalPersistRoot = service.persistRoot.bind(service);
  service.persistRoot = async () => {
    throw new Error("persist failed");
  };
  return originalPersistRoot;
}

async function reopenRollbackArchive(service, archivePath) {
  await service.closeArchive();
  await service.openArchive({ archivePath, password: "password" });
}

async function reopenWithRecoveredJournal(service, archivePath) {
  await service.closeArchive();
  await service.openArchive({ archivePath, password: "password" });
}

function hashRoot(root) {
  return createHash("sha256").update(JSON.stringify(JSON.parse(JSON.stringify(root)))).digest("hex");
}

test("archive service creates a v3 archive, ingests files, exports, and deletes entries", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = true;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "hello.txt");
    await fs.writeFile(sourcePath, "hello world");
    await service.addPaths([sourcePath]);
    await assert.rejects(() => fs.access(sourcePath), /ENOENT/);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].name, "hello.txt");

    const detail = await service.getEntryDetail(listing.items[0].id);
    assert.equal(detail.revisions.length, 1);

    const exportDir = path.join(tempDir, "exports");
    await fs.mkdir(exportDir);
    await service.exportEntry(detail.id, exportDir);
    const exported = await fs.readFile(path.join(exportDir, "hello.txt"), "utf8");
    assert.equal(exported, "hello world");

    await service.deleteEntry(detail.id);
    const afterDelete = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(afterDelete.total, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service preserves archive paths when exporting and can remove exported entries", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-export-paths-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();
    await service.createArchive({
      parentPath: tempDir,
      name: "export-paths",
      password: "password",
      preferences: state.settings
    });

    const alphaPath = path.join(tempDir, "alpha.txt");
    const betaPath = path.join(tempDir, "beta.txt");
    await fs.writeFile(alphaPath, "alpha");
    await fs.writeFile(betaPath, "beta");
    await service.createFolder(path.join("docs", "letters"));
    await service.createFolder(path.join("docs", "notes"));
    await service.addPaths([alphaPath], { destinationDirectory: path.join("docs", "letters") });
    await service.addPaths([betaPath], { destinationDirectory: path.join("docs", "notes") });

    const alphaId = await service.findEntryIdByRelativePath(path.join("docs", "letters", "alpha.txt"));
    const betaId = await service.findEntryIdByRelativePath(path.join("docs", "notes", "beta.txt"));
    assert.ok(alphaId);
    assert.ok(betaId);

    const exportDir = path.join(tempDir, "exports");
    await fs.mkdir(exportDir);
    await service.exportEntries(
      [
        { entryId: alphaId },
        { entryId: betaId }
      ],
      exportDir,
      { preservePaths: true, removeFromArchive: true }
    );

    assert.equal(await fs.readFile(path.join(exportDir, "docs", "letters", "alpha.txt"), "utf8"), "alpha");
    assert.equal(await fs.readFile(path.join(exportDir, "docs", "notes", "beta.txt"), "utf8"), "beta");

    assert.equal(await service.findEntryIdByRelativePath(path.join("docs", "letters", "alpha.txt")), null);
    assert.equal(await service.findEntryIdByRelativePath(path.join("docs", "notes", "beta.txt")), null);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service resolves filename collisions when flattening exports", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-export-collisions-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();
    await service.createArchive({
      parentPath: tempDir,
      name: "export-collisions",
      password: "password",
      preferences: state.settings
    });

    const sourceDirA = path.join(tempDir, "source-a");
    const sourceDirB = path.join(tempDir, "source-b");
    await fs.mkdir(sourceDirA);
    await fs.mkdir(sourceDirB);
    const firstPath = path.join(sourceDirA, "report.txt");
    const secondPath = path.join(sourceDirB, "report.txt");
    await fs.writeFile(firstPath, "first");
    await fs.writeFile(secondPath, "second");
    await service.createFolder("folder-a");
    await service.createFolder("folder-b");
    await service.addPaths([firstPath], { destinationDirectory: "folder-a" });
    await service.addPaths([secondPath], { destinationDirectory: "folder-b" });

    const firstId = await service.findEntryIdByRelativePath(path.join("folder-a", "report.txt"));
    const secondId = await service.findEntryIdByRelativePath(path.join("folder-b", "report.txt"));
    assert.ok(firstId);
    assert.ok(secondId);

    const exportDir = path.join(tempDir, "flat-exports");
    await fs.mkdir(exportDir);
    await service.exportEntries(
      [
        { entryId: firstId },
        { entryId: secondId }
      ],
      exportDir,
      { preservePaths: false }
    );

    const exportedFiles = (await fs.readdir(exportDir)).sort();
    assert.deepEqual(exportedFiles, ["report (2).txt", "report.txt"]);
    assert.equal(await fs.readFile(path.join(exportDir, "report.txt"), "utf8"), "first");
    assert.equal(await fs.readFile(path.join(exportDir, "report (2).txt"), "utf8"), "second");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service honors the requested lower stored export option", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-export-option-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();
    await service.createArchive({
      parentPath: tempDir,
      name: "export-option",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "hello.txt");
    const archivedPath = path.join(tempDir, "hello-archived.txt");
    const smallerPath = path.join(tempDir, "hello-smaller.txt");
    await fs.writeFile(sourcePath, "highest quality");
    await fs.writeFile(archivedPath, "archived quality");
    await fs.writeFile(smallerPath, "smaller");
    await service.addPaths([sourcePath]);

    const entryId = await service.findEntryIdByRelativePath("hello.txt");
    assert.ok(entryId);
    const entry = await service.loadEntry(entryId);
    assert.ok(entry);

    const session = service.requireArchiveSession();
    const archivedDescriptor = await session.objectStore.storeFile(archivedPath, session.root.preferences.compressionBehavior, {
      extension: ".txt",
      mime: "text/plain"
    });
    const smallerDescriptor = await session.objectStore.storeFile(smallerPath, session.root.preferences.compressionBehavior, {
      extension: ".txt",
      mime: "text/plain"
    });
    entry.revisions[0].preferredArtifact = {
      label: "archived",
      extension: ".txt",
      mime: "text/plain",
      ...archivedDescriptor
    };
    entry.revisions[0].optimizedArtifact = entry.revisions[0].preferredArtifact;
    entry.revisions[0].derivativeArtifacts = [{
      label: "smaller",
      extension: ".txt",
      mime: "text/plain",
      ...smallerDescriptor
    }];
    entry.revisions[0].optimizationDecision = {
      plannerVersion: "planner-v1",
      selectedCandidateId: "archived",
      candidateMetrics: [
        {
          id: "archived",
          label: "archived",
          size: archivedDescriptor.size,
          estimatedQuality: 72,
          reversible: false,
          accepted: true
        },
        {
          id: "smaller",
          label: "smaller",
          size: smallerDescriptor.size,
          estimatedQuality: 48,
          reversible: false,
          accepted: true
        }
      ],
      sourceSummary: "text"
    };
    await service.saveEntry(entry);

    const detail = await service.getEntryDetail(entryId);
    assert.equal(detail.exportOptions.length, 2);

    const exportDir = path.join(tempDir, "exports");
    await fs.mkdir(exportDir);
    await service.exportEntry(entryId, exportDir, { exportOptionId: detail.exportOptions[1].id });

    assert.equal(await fs.readFile(path.join(exportDir, "hello.txt"), "utf8"), "smaller");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service ingests jpeg xl uploads as opaque files when the bundled decoder cannot read them", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-jxl-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "jxl-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "optimized-photo.jxl");
    const payload = Buffer.from("opaque jxl payload");
    await fs.writeFile(sourcePath, payload);
    await service.addPaths([sourcePath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].name, "optimized-photo.jxl");
    assert.equal(listing.items[0].fileKind, "file");
    assert.equal(listing.items[0].previewable, true);

    const detail = await service.getEntryDetail(listing.items[0].id);
    assert.equal(detail.exportable, true);
    assert.equal(await service.resolveEntryPreview(detail.id, "preview"), null);

    const exportDir = path.join(tempDir, "exports");
    await fs.mkdir(exportDir);
    await service.exportEntry(detail.id, exportDir);
    const exported = await fs.readFile(path.join(exportDir, "optimized-photo.jxl"));
    assert.deepEqual(exported, payload);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service precomputes previews for jpeg xl uploads when djxl is available", async (t) => {
  try {
    await runCommand("djxl", ["--version"]);
    await runCommand("cjxl", ["--version"]);
  } catch (_error) {
    t.skip("jpeg xl tools are not available");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-jxl-preview-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.capabilities = {
      djxl: { available: true, path: "djxl" }
    };
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "jxl-preview-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePngPath = path.join(tempDir, "source.png");
    const sourceJxlPath = path.join(tempDir, "source.jxl");
    await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: { r: 36, g: 84, b: 192 }
      }
    })
      .png()
      .toFile(sourcePngPath);
    await runCommand("cjxl", [sourcePngPath, sourceJxlPath]);

    await service.addPaths([sourceJxlPath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].fileKind, "image");
    assert.equal(listing.items[0].previewable, true);

    const detail = await service.getEntryDetail(listing.items[0].id);
    assert.equal(detail.revisions[0].media.width, 640);
    assert.equal(detail.revisions[0].media.height, 360);

    const preview = await service.resolveEntryPreview(detail.id, "preview");
    assert.ok(preview);
    assert.match(preview.mime, /^image\//);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service can preview legacy jpeg xl entries that were previously stored as opaque files", async (t) => {
  try {
    await runCommand("djxl", ["--version"]);
    await runCommand("cjxl", ["--version"]);
  } catch (_error) {
    t.skip("jpeg xl tools are not available");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-jxl-legacy-preview-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "jxl-legacy-preview-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePngPath = path.join(tempDir, "legacy-source.png");
    const sourceJxlPath = path.join(tempDir, "legacy-source.jxl");
    await sharp({
      create: {
        width: 480,
        height: 270,
        channels: 3,
        background: { r: 120, g: 48, b: 160 }
      }
    })
      .png()
      .toFile(sourcePngPath);
    await runCommand("cjxl", [sourcePngPath, sourceJxlPath]);

    await service.addPaths([sourceJxlPath]);

    let listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.items[0].fileKind, "file");
    assert.equal(listing.items[0].previewable, true);

    state.capabilities = {
      djxl: { available: true, path: "djxl" }
    };

    const preview = await service.resolveEntryPreview(listing.items[0].id, "thumbnail");
    assert.ok(preview);
    assert.match(preview.mime, /^image\//);

    listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.items[0].previewable, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service deletes an open archive and clears the active session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-delete-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "delete-me",
      password: "password",
      preferences: state.settings
    });

    const archivePath = state.archiveSession?.path;
    assert.ok(archivePath);

    await service.deleteArchive(archivePath);

    await assert.rejects(() => fs.access(archivePath), /ENOENT/);
    assert.equal(state.archiveSession, null);
    assert.equal(state.lockedArchive, null);
    await assert.rejects(() => service.getStats(), /No archive is open/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("recent archives track actual open events and can be removed", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-recent-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "recent-demo",
      password: "password",
      preferences: state.settings
    });

    const archivePath = state.archiveSession.path;
    assert.equal(state.recentArchives.length, 1);
    assert.equal(state.recentArchives[0].path, archivePath);
    assert.equal(state.recentArchives[0].name, "recent-demo");

    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });

    const reloadedState = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    assert.equal(reloadedState.recentArchives.length, 1);
    assert.equal(reloadedState.recentArchives[0].path, archivePath);

    await service.removeRecentArchive(archivePath);
    assert.equal(state.recentArchives.length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("recent archives are capped to a practical bound", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-recent-cap-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    for (let index = 0; index < 25; index += 1) {
      await service.trackRecentArchive(path.join(tempDir, `archive-${index}.stow`), `archive-${index}`);
    }

    assert.equal(state.recentArchives.length, 20);
    assert.equal(state.recentArchives[0].name, "archive-24");
    assert.equal(state.recentArchives.at(-1).name, "archive-5");

    const persisted = JSON.parse(await fs.readFile(state.recentArchivesPath, "utf8"));
    assert.equal(persisted.length, 20);
    assert.equal(persisted[0].name, "archive-24");
    assert.equal(persisted.at(-1).name, "archive-5");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service renames entries and rejects invalid collisions", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-rename-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const firstSourcePath = path.join(tempDir, "alpha.txt");
    const secondSourcePath = path.join(tempDir, "beta.txt");
    await fs.writeFile(firstSourcePath, "alpha");
    await fs.writeFile(secondSourcePath, "beta");
    await service.addPaths([firstSourcePath, secondSourcePath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    const alphaEntry = listing.items.find((entry) => entry.name === "alpha.txt");
    assert.ok(alphaEntry);

    await service.renameEntry(alphaEntry.id, "renamed.txt");
    const renamed = await service.getEntryDetail(alphaEntry.id);
    assert.equal(renamed.name, "renamed.txt");
    assert.equal(renamed.relativePath, "renamed.txt");

    await assert.rejects(() => service.renameEntry(alphaEntry.id, "beta.txt"), /already exists/);
    await assert.rejects(() => service.renameEntry(alphaEntry.id, "nested\\/name.txt"), /path separators/);
    await assert.rejects(() => service.renameEntry(alphaEntry.id, "con"), /Windows|reserved/);
    await assert.rejects(() => service.renameEntry(alphaEntry.id, "bad<name>.txt"), /Windows/);
    await assert.rejects(() => service.createFolder("bad<folder>"), /Windows/);
    await assert.rejects(() => service.createFolder("nested/aux"), /Windows|reserved/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service refuses to follow symlinked input directories", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-symlink-ingest-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "symlink-demo",
      password: "password",
      preferences: state.settings
    });

    const sourceDir = path.join(tempDir, "source");
    const linkedTargetDir = path.join(tempDir, "linked-target");
    const sourceDirLink = path.join(tempDir, "source-link");
    await fs.mkdir(sourceDir);
    await fs.mkdir(linkedTargetDir);
    await fs.writeFile(path.join(sourceDir, "real.txt"), "real");
    await fs.writeFile(path.join(linkedTargetDir, "sneaky.txt"), "sneaky");

    if (!(await createSymlinkOrSkip(t, linkedTargetDir, path.join(sourceDir, "linked-dir"), "dir"))) {
      return;
    }
    if (!(await createSymlinkOrSkip(t, sourceDir, sourceDirLink, "dir"))) {
      return;
    }

    await assert.rejects(() => service.addPaths([sourceDir]), /Symlinked input paths are not supported/);

    await assert.rejects(() => service.addPaths([sourceDirLink]), /Symlinked input paths are not supported/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service renames and moves folders via folder entry ids", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-folder-rename-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "folder-demo",
      password: "password",
      preferences: state.settings
    });

    await service.createFolder("projects");
    await service.createFolder("projects/assets");
    await service.createFolder("library");

    const sourcePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(sourcePath, "folder rename");
    await service.addPaths([sourcePath], { destinationDirectory: "projects/assets" });

    await service.renameEntry("folder:projects", "work");
    await service.moveEntry(`folder:${path.join("work", "assets")}`, "library");

    const rootListing = await service.listEntries({ directory: "", offset: 0, limit: 10 });
    const rootFolders = rootListing.items.filter((entry) => entry.entryType === "folder").map((entry) => entry.relativePath).sort();
    assert.deepEqual(rootFolders, ["library", "work"]);

    const libraryListing = await service.listEntries({ directory: "library", offset: 0, limit: 10 });
    assert.equal(libraryListing.items[0].relativePath, path.join("library", "assets"));

    const assetListing = await service.listEntries({ directory: path.join("library", "assets"), offset: 0, limit: 10 });
    const notesEntry = assetListing.items.find((entry) => entry.entryType === "file" && entry.name === "notes.txt");
    assert.ok(notesEntry);
    assert.equal(notesEntry.relativePath, path.join("library", "assets", "notes.txt"));
    assert.deepEqual(state.archiveSession.root.folders, ["library", path.join("library", "assets"), "work"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service supports explicit folders, directory listings, destination ingest, and file moves", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-folders-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "folders-demo",
      password: "password",
      preferences: state.settings
    });

    await service.createFolder("projects");
    await service.createFolder("projects/assets");

    const sourcePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(sourcePath, "folder aware");
    await service.addPaths([sourcePath], { destinationDirectory: "projects" });

    const rootListing = await service.listEntries({ directory: "", offset: 0, limit: 10 });
    assert.equal(rootListing.total, 1);
    assert.equal(rootListing.items[0].entryType, "folder");
    assert.equal(rootListing.items[0].relativePath, "projects");

    const projectsListing = await service.listEntries({ directory: "projects", offset: 0, limit: 10 });
    assert.equal(projectsListing.total, 2);
    assert.equal(projectsListing.items[0].entryType, "folder");
    assert.equal(projectsListing.items[0].relativePath, "projects/assets");
    const notesEntry = projectsListing.items.find((entry) => entry.entryType === "file" && entry.name === "notes.txt");
    assert.ok(notesEntry);

    await service.moveEntry(notesEntry.id, "projects/assets");

    const movedListing = await service.listEntries({ directory: "projects/assets", offset: 0, limit: 10 });
    assert.equal(movedListing.total, 1);
    assert.equal(movedListing.items[0].entryType, "file");
    assert.equal(movedListing.items[0].relativePath, path.join("projects", "assets", "notes.txt"));

    const movedDetail = await service.getEntryDetail(notesEntry.id);
    assert.equal(movedDetail.relativePath, path.join("projects", "assets", "notes.txt"));
    assert.deepEqual(state.archiveSession.root.folders, ["projects", path.join("projects", "assets")]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service sorts directory listings before pagination", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-list-order-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "order-demo",
      password: "password",
      preferences: state.settings
    });

    const filePaths = [
      path.join(tempDir, "gamma.txt"),
      path.join(tempDir, "alpha.txt"),
      path.join(tempDir, "beta.txt")
    ];
    await Promise.all([
      fs.writeFile(filePaths[0], "gamma"),
      fs.writeFile(filePaths[1], "a"),
      fs.writeFile(filePaths[2], "beta")
    ]);
    await service.addPaths(filePaths);

    const firstPage = await service.listEntries({ offset: 0, limit: 2, sortColumn: "name", sortDirection: "asc" });
    assert.equal(firstPage.total, 3);
    assert.deepEqual(firstPage.items.map((entry) => entry.name), ["alpha.txt", "beta.txt"]);

    const secondPage = await service.listEntries({ offset: 2, limit: 2, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(secondPage.items.map((entry) => entry.name), ["gamma.txt"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service serves warm list queries from the query index and stays coherent across folder/file mutations", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-query-index-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "query-index-demo",
      password: "password",
      preferences: state.settings
    });

    await service.createFolder("docs");
    await service.createFolder(path.join("docs", "nested"));
    const alphaPath = path.join(tempDir, "alpha.txt");
    const betaPath = path.join(tempDir, "beta.txt");
    await fs.writeFile(alphaPath, "alpha");
    await fs.writeFile(betaPath, "beta");
    await service.addPaths([alphaPath, betaPath], { destinationDirectory: "docs" });

    let docsListing = await service.listEntries({ directory: "docs", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);

    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm query-index reads");
    };
    docsListing = await service.listEntries({ directory: "docs", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);
    service.loadEntry = originalLoadEntry;

    const alphaEntry = docsListing.items.find((entry) => entry.entryType === "file" && entry.name === "alpha.txt");
    const betaEntry = docsListing.items.find((entry) => entry.entryType === "file" && entry.name === "beta.txt");
    assert.ok(alphaEntry);
    assert.ok(betaEntry);

    await service.renameEntry(alphaEntry.id, "gamma.txt");
    docsListing = await service.listEntries({ directory: "docs", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "beta.txt", "gamma.txt"]);

    await service.moveEntry(betaEntry.id, path.join("docs", "nested"));
    docsListing = await service.listEntries({ directory: "docs", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "gamma.txt"]);
    const nestedListing = await service.listEntries({
      directory: path.join("docs", "nested"),
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(nestedListing.items.map((entry) => entry.name), ["beta.txt"]);

    await service.deleteFolder(path.join("docs", "nested"));
    docsListing = await service.listEntries({ directory: "docs", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["gamma.txt"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service reopens from persisted entry summaries without reading entry catalogs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-summary-reopen-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "summary-reopen-demo",
      password: "password",
      preferences: state.settings
    });

    const firstPath = path.join(tempDir, "first.txt");
    const secondPath = path.join(tempDir, "second.txt");
    await fs.writeFile(firstPath, "one");
    await fs.writeFile(secondPath, "two");
    await service.addPaths([firstPath, secondPath]);

    const archivePath = state.archiveSession.path;
    await service.closeArchive();

    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run when persisted summaries are current");
    };

    await service.openArchive({ archivePath, password: "password" });
    const listing = await service.listEntries({ directory: "", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.deepEqual(listing.items.map((entry) => entry.name), ["first.txt", "second.txt"]);
    service.loadEntry = originalLoadEntry;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rebuilds legacy entry summaries so preview metadata remains available", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-summary-legacy-preview-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "summary-legacy-preview-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "preview-source.png");
    await sharp({
      create: {
        width: 320,
        height: 200,
        channels: 3,
        background: { r: 48, g: 92, b: 160 }
      }
    })
      .png()
      .toFile(sourcePath);

    await service.addPaths([sourcePath]);

    const archivePath = state.archiveSession.path;
    const archiveKey = Buffer.from(state.archiveSession.archiveKey);
    await service.closeArchive();

    const summaryIndex = await readEntrySummaryIndex(archivePath, archiveKey);
    await writeEntrySummaryIndex(
      archivePath,
      archiveKey,
      {
        ...summaryIndex,
        version: 1,
        entries: Object.fromEntries(
          Object.entries(summaryIndex.entries).map(([entryId, entry]) => {
            const { previewable, ...legacyEntry } = entry;
            return [entryId, legacyEntry];
          })
        )
      }
    );

    await service.openArchive({ archivePath, password: "password" });
    const listing = await service.listEntries({ directory: "", offset: 0, limit: 10, sortColumn: "name", sortDirection: "asc" });
    assert.equal(listing.items[0].previewable, true);

    const rewrittenSummaryIndex = await readEntrySummaryIndex(archivePath, archiveKey);
    assert.equal(rewrittenSummaryIndex.version, 2);
    const rewrittenEntry = Object.values(rewrittenSummaryIndex.entries)[0];
    assert.equal(rewrittenEntry.previewable, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service backfills and rewrites entry summaries when summary index is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-summary-backfill-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "summary-backfill-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "note.txt");
    await fs.writeFile(sourcePath, "note");
    await service.addPaths([sourcePath]);

    const archivePath = state.archiveSession.path;
    await service.closeArchive();

    const summaryIndexPath = path.join(archivePath, "catalog", "entry-summary.enc");
    await fs.rm(summaryIndexPath, { force: true });

    await service.openArchive({ archivePath, password: "password" });
    let listing = await service.listEntries({ directory: "", offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    await service.closeArchive();

    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run after summary backfill persisted");
    };
    await service.openArchive({ archivePath, password: "password" });
    listing = await service.listEntries({ directory: "", offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    service.loadEntry = originalLoadEntry;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service deletes folders and their nested contents", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-delete-folder-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "delete-folder-demo",
      password: "password",
      preferences: state.settings
    });

    await service.createFolder("projects");
    await service.createFolder("projects/assets");

    const sourcePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(sourcePath, "folder delete");
    await service.addPaths([sourcePath], { destinationDirectory: "projects/assets" });

    await service.deleteFolder("projects");

    const rootListing = await service.listEntries({ directory: "", offset: 0, limit: 10 });
    assert.equal(rootListing.total, 0);
    assert.deepEqual(state.archiveSession.root.folders, []);
    assert.equal(state.archiveSession.root.stats.entryCount, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service preserves uploaded originals when deletion is disabled", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-no-delete-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "keep.txt");
    await fs.writeFile(sourcePath, "keep me");
    await service.addPaths([sourcePath]);

    const sourceContents = await fs.readFile(sourcePath, "utf8");
    assert.equal(sourceContents, "keep me");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive preferences are editable independently from app settings", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-policy-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "policy-demo",
      password: "password",
      preferences: state.settings
    });

    assert.equal(state.archiveSession.root.preferences.compressionBehavior, "balanced");
    await service.saveSettings({ compressionBehavior: "max" });
    assert.equal(state.settings.compressionBehavior, "max");
    assert.equal(state.archiveSession.root.preferences.compressionBehavior, "balanced");

    await service.setArchivePreferences({ compressionBehavior: "fast" });
    assert.equal(state.archiveSession.root.preferences.compressionBehavior, "fast");

    const archivePath = state.archiveSession.path;
    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });
    assert.equal(state.archiveSession.root.preferences.compressionBehavior, "fast");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service stores one file-tree entry per relative path and reprocesses from stored originals", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-revisions-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "versioned.txt");
    await fs.writeFile(sourcePath, "one");
    await service.addPaths([sourcePath]);

    await fs.writeFile(sourcePath, "two");
    await service.addPaths([sourcePath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 1);

    const detail = await service.getEntryDetail(listing.items[0].id);
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.revisions[0].source?.relativePath, "versioned.txt");
    assert.equal("absolutePath" in (detail.revisions[0].source || {}), false);

    await fs.rm(sourcePath, { force: true });
    await service.reprocessEntry(detail.id, "lossless");

    const reprocessed = await service.getEntryDetail(detail.id);
    assert.equal(reprocessed.revisions.length, 3);
    assert.equal(reprocessed.revisions[0].overrideMode, "lossless");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service normalizes legacy revisions to keep only the stored artifact", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-migrate-artifacts-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "migrate-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "source.txt");
    const processedPath = path.join(tempDir, "processed.txt");
    await fs.writeFile(sourcePath, "source bytes that should not survive migration");
    await fs.writeFile(processedPath, "processed bytes that remain stored");

    const session = state.archiveSession;
    const originalArtifact = await session.objectStore.storeFile(
      sourcePath,
      session.root.preferences.compressionBehavior,
      {
        extension: ".txt",
        mime: "text/plain"
      }
    );
    const optimizedArtifact = await session.objectStore.storeFile(
      processedPath,
      session.root.preferences.compressionBehavior,
      {
        extension: ".txt",
        mime: "text/plain"
      }
    );

    const entryId = "123e4567-e89b-42d3-a456-426614174010";
    const revisionId = "123e4567-e89b-42d3-a456-426614174011";
    const sourceSize = Buffer.byteLength("source bytes that should not survive migration");
    const entry = {
      id: entryId,
      name: "source.txt",
      relativePath: "source.txt",
      fileKind: "file",
      mime: "text/plain",
      size: sourceSize,
      createdAt: new Date().toISOString(),
      latestRevisionId: revisionId,
      revisions: [{
        id: revisionId,
        addedAt: new Date().toISOString(),
        source: {
          relativePath: "source.txt",
          size: sourceSize
        },
        media: {},
        overrideMode: null,
        summary: "example",
        actions: [],
        originalArtifact: {
          label: "original",
          extension: ".txt",
          mime: "text/plain",
          ...originalArtifact
        },
        optimizedArtifact: {
          label: "optimized",
          extension: ".txt",
          mime: "text/plain",
          ...optimizedArtifact
        }
      }]
    };

    session.root.entryOrder = [entryId];
    session.root.stats.entryCount = 1;
    session.root.stats.logicalBytes = sourceSize;
    session.root.stats.storedBytes = originalArtifact.storageStats.storedBytes + optimizedArtifact.storageStats.storedBytes;
    await service.saveEntry(entry);
    await service.persistRoot();

    const beforeReopen = await service.getStats();
    assert.equal(beforeReopen.storedBytes, originalArtifact.storageStats.storedBytes + optimizedArtifact.storageStats.storedBytes);

    const archivePath = path.join(tempDir, "migrate-demo.stow");
    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });

    const detail = await service.getEntryDetail(entryId);
    assert.equal(detail.size, optimizedArtifact.size);
    assert.equal(detail.sourceSize, sourceSize);
    assert.equal(detail.revisions[0].optimizedArtifact, null);

    const afterReopen = await service.getStats();
    assert.equal(afterReopen.storedBytes, optimizedArtifact.storageStats.storedBytes);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service clears ingest progress after an ingest failure", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-progress-reset-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const progressEvents = [];
    const service = new ArchiveService(state, createEmitters({
      emitProgress: (payload) => progressEvents.push(payload)
    }));
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "progress-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "broken.txt");
    await fs.writeFile(sourcePath, "boom");
    service.ingestSource = async () => {
      throw new Error("ingest failed");
    };

    await assert.rejects(() => service.addPaths([sourcePath]), /ingest failed/);
    assert.equal(progressEvents.at(-1)?.active, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back add-paths mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-add-rollback-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "rollback-demo",
      password: "password",
      preferences: state.settings
    });

    const archivePath = path.join(tempDir, "rollback-demo.stow");
    const originalPersistRoot = service.persistRoot.bind(service);
    service.persistRoot = async () => {
      throw new Error("persist failed");
    };

    const sourcePath = path.join(tempDir, "rollback.txt");
    await fs.writeFile(sourcePath, "hello rollback");

    await assert.rejects(() => service.addPaths([sourcePath]), /persist failed/);

    let listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 0);
    assert.equal((await service.getStats()).entryCount, 0);

    service.persistRoot = originalPersistRoot;
    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });

    listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 0);
    assert.equal((await service.getStats()).entryCount, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back reprocess mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-reprocess-rollback-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "reprocess-rollback-demo",
      password: "password",
      preferences: state.settings
    });

    const archivePath = path.join(tempDir, "reprocess-rollback-demo.stow");
    const sourcePath = path.join(tempDir, "versioned.txt");
    await fs.writeFile(sourcePath, "one");
    await service.addPaths([sourcePath]);

    const initialListing = await service.listEntries({ offset: 0, limit: 10 });
    const entryId = initialListing.items[0].id;
    const initialDetail = await service.getEntryDetail(entryId);
    assert.equal(initialDetail.revisions.length, 1);

    const originalPersistRoot = service.persistRoot.bind(service);
    service.persistRoot = async () => {
      throw new Error("persist failed");
    };

    await assert.rejects(() => service.reprocessEntry(entryId, "lossless"), /persist failed/);

    let detail = await service.getEntryDetail(entryId);
    assert.equal(detail.revisions.length, 1);
    assert.equal(detail.latestRevisionId, initialDetail.latestRevisionId);

    service.persistRoot = originalPersistRoot;
    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });

    detail = await service.getEntryDetail(entryId);
    assert.equal(detail.revisions.length, 1);
    assert.equal(detail.latestRevisionId, initialDetail.latestRevisionId);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back delete-entry mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-delete-entry-rollback-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "delete-entry-rollback-demo",
      password: "password",
      preferences: state.settings
    });

    const archivePath = path.join(tempDir, "delete-entry-rollback-demo.stow");
    const sourcePath = path.join(tempDir, "kept.txt");
    await fs.writeFile(sourcePath, "keep me");
    await service.addPaths([sourcePath]);

    const initialListing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(initialListing.total, 1);
    const entryId = initialListing.items[0].id;

    const originalPersistRoot = service.persistRoot.bind(service);
    service.persistRoot = async () => {
      throw new Error("persist failed");
    };

    await assert.rejects(() => service.deleteEntry(entryId), /persist failed/);

    let listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].id, entryId);
    assert.equal((await service.getStats()).entryCount, 1);

    service.persistRoot = originalPersistRoot;
    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });

    listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].id, entryId);
    assert.equal((await service.getStats()).entryCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back folder-delete mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-folder-delete-rollback-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "folder-delete-rollback-demo",
      password: "password",
      preferences: state.settings
    });

    const archivePath = path.join(tempDir, "folder-delete-rollback-demo.stow");
    await service.createFolder("projects");
    await service.createFolder("projects/assets");

    const sourcePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(sourcePath, "notes");
    await service.addPaths([sourcePath], { destinationDirectory: path.join("projects", "assets") });

    const originalPersistRoot = service.persistRoot.bind(service);
    service.persistRoot = async () => {
      throw new Error("persist failed");
    };

    await assert.rejects(() => service.deleteFolder("projects"), /persist failed/);

    let nestedListing = await service.listEntries({ directory: path.join("projects", "assets"), offset: 0, limit: 10 });
    assert.equal(nestedListing.total, 1);
    assert.equal((await service.getStats()).entryCount, 1);
    assert.equal(await service.folderExists("projects"), true);

    service.persistRoot = originalPersistRoot;
    await service.closeArchive();
    await service.openArchive({ archivePath, password: "password" });

    nestedListing = await service.listEntries({ directory: path.join("projects", "assets"), offset: 0, limit: 10 });
    assert.equal(nestedListing.total, 1);
    assert.equal((await service.getStats()).entryCount, 1);
    assert.equal(await service.folderExists("projects"), true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back file rename and move mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-rename-move-rollback-"));
  try {
    const { service, archivePath } = await createRollbackTestFixture(tempDir, "rename-move-rollback-demo");
    await service.createFolder("docs");
    await service.createFolder(path.join("docs", "nested"));
    await service.createFolder("library");

    const alphaPath = path.join(tempDir, "alpha.txt");
    const betaPath = path.join(tempDir, "beta.txt");
    await fs.writeFile(alphaPath, "alpha");
    await fs.writeFile(betaPath, "beta");
    await service.addPaths([alphaPath, betaPath], { destinationDirectory: "docs" });

    let docsListing = await service.listEntries({
      directory: "docs",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);

    const alphaEntry = docsListing.items.find((entry) => entry.entryType === "file" && entry.name === "alpha.txt");
    const betaEntry = docsListing.items.find((entry) => entry.entryType === "file" && entry.name === "beta.txt");
    assert.ok(alphaEntry);
    assert.ok(betaEntry);

    const originalPersistRoot = stubPersistRootFailure(service);
    await assert.rejects(() => service.renameEntry(alphaEntry.id, "gamma.txt"), /persist failed/);
    service.persistRoot = originalPersistRoot;

    await reopenRollbackArchive(service, archivePath);
    docsListing = await service.listEntries({
      directory: "docs",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);

    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm query-index reads");
    };

    docsListing = await service.listEntries({
      directory: "docs",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);
    service.loadEntry = originalLoadEntry;

    const originalPersistRootForMove = stubPersistRootFailure(service);
    await assert.rejects(() => service.moveEntry(betaEntry.id, "library"), /persist failed/);
    service.persistRoot = originalPersistRootForMove;

    await reopenRollbackArchive(service, archivePath);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm query-index reads");
    };

    docsListing = await service.listEntries({
      directory: "docs",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(docsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);

    const libraryListing = await service.listEntries({
      directory: "library",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.equal(libraryListing.total, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service reopens safely when an interrupted file-mutation journal survives a crash", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-file-journal-reopen-"));
  try {
    const { service, archivePath } = await createRollbackTestFixture(tempDir, "file-journal-reopen-demo");
    await service.createFolder("library");

    const alphaPath = path.join(tempDir, "alpha.txt");
    const betaPath = path.join(tempDir, "beta.txt");
    await fs.writeFile(alphaPath, "alpha");
    await fs.writeFile(betaPath, "beta");
    await service.addPaths([alphaPath, betaPath]);

    const initialListing = await service.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    const alphaEntry = initialListing.items.find((entry) => entry.entryType === "file" && entry.name === "alpha.txt");
    const betaEntry = initialListing.items.find((entry) => entry.entryType === "file" && entry.name === "beta.txt");
    assert.ok(alphaEntry);
    assert.ok(betaEntry);

    const archiveKey = Buffer.from(service.state.archiveSession.archiveKey);
    const rootSnapshot = JSON.parse(JSON.stringify(service.state.archiveSession.root));
    const alphaCatalog = await readEntryCatalog(archivePath, archiveKey, alphaEntry.id);
    const betaCatalog = await readEntryCatalog(archivePath, archiveKey, betaEntry.id);
    const interruptedAlphaCatalog = JSON.parse(JSON.stringify(alphaCatalog));
    interruptedAlphaCatalog.name = "gamma.txt";
    interruptedAlphaCatalog.relativePath = "gamma.txt";
    const interruptedBetaCatalog = JSON.parse(JSON.stringify(betaCatalog));
    interruptedBetaCatalog.relativePath = path.join("library", "beta.txt");
    await writeEntryCatalog(archivePath, archiveKey, interruptedAlphaCatalog);
    await writeEntryCatalog(archivePath, archiveKey, interruptedBetaCatalog);

    const journal = {
      version: 1,
      type: "metadata-mutation",
      state: "pending",
      startedAt: new Date().toISOString(),
      archiveId: rootSnapshot.archiveId,
      rootSnapshotUpdatedAt: rootSnapshot.updatedAt,
      rootSnapshot,
      targetRootUpdatedAt: null,
      targetRootDigest: null,
      trackedEntryCatalogs: {
        [alphaEntry.id]: alphaCatalog,
        [betaEntry.id]: betaCatalog
      }
    };

    await service.closeArchive();
    await writeMutationJournal(archivePath, archiveKey, journal);
    assert.deepEqual(await readMutationJournal(archivePath, archiveKey), journal);
    await fs.rm(entrySummaryIndexPath(archivePath), { force: true });

    await service.openArchive({ archivePath, password: "password" });
    let rootListing = await service.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.equal(rootListing.items.some((entry) => entry.name === "gamma.txt"), false);
    assert.equal(rootListing.items.some((entry) => entry.name === "alpha.txt"), true);
    assert.equal(rootListing.items.some((entry) => entry.entryType === "folder" && entry.relativePath === "library"), true);

    let libraryListing = await service.listEntries({
      directory: "library",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(libraryListing.items.map((entry) => entry.relativePath), []);
    const detail = await service.getEntryDetail(betaEntry.id);
    assert.equal(detail.relativePath, "beta.txt");
    await fs.access(entrySummaryIndexPath(archivePath));

    await reopenWithRecoveredJournal(service, archivePath);
    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm journal recovery reads");
    };

    rootListing = await service.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.equal(rootListing.items.some((entry) => entry.name === "gamma.txt"), false);
    assert.equal(rootListing.items.some((entry) => entry.name === "alpha.txt"), true);
    assert.equal(rootListing.items.some((entry) => entry.entryType === "folder" && entry.relativePath === "library"), true);

    libraryListing = await service.listEntries({
      directory: "library",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(libraryListing.items.map((entry) => entry.relativePath), []);
    service.loadEntry = originalLoadEntry;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back folder rename and folder move mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-folder-move-rollback-"));
  try {
    const { service, archivePath } = await createRollbackTestFixture(tempDir, "folder-move-rollback-demo");
    await service.createFolder("projects");
    await service.createFolder(path.join("projects", "assets"));
    await service.createFolder("library");

    const sourcePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(sourcePath, "notes");
    await service.addPaths([sourcePath], { destinationDirectory: path.join("projects", "assets") });

    const originalPersistRoot = stubPersistRootFailure(service);
    await assert.rejects(() => service.renameEntry("folder:projects", "work"), /persist failed/);
    service.persistRoot = originalPersistRoot;

    await reopenRollbackArchive(service, archivePath);
    assert.equal(await service.folderExists("projects"), true);
    assert.equal(await service.folderExists("work"), false);

    const originalPersistRootForMove = stubPersistRootFailure(service);
    await assert.rejects(
      () => service.moveEntry(`folder:${path.join("projects", "assets")}`, "library"),
      /persist failed/
    );
    service.persistRoot = originalPersistRootForMove;

    await reopenRollbackArchive(service, archivePath);
    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm query-index reads");
    };

    const rootListing = await service.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(rootListing.items.map((entry) => entry.relativePath), ["library", "projects"]);

    const projectsListing = await service.listEntries({
      directory: "projects",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(projectsListing.items.map((entry) => entry.relativePath), [path.join("projects", "assets")]);
    service.loadEntry = originalLoadEntry;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service reopens safely when a stale committed folder-mutation journal survives a crash", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-folder-journal-reopen-"));
  try {
    const { service, archivePath } = await createRollbackTestFixture(tempDir, "folder-journal-reopen-demo");
    await service.createFolder("projects");
    await service.createFolder(path.join("projects", "assets"));
    await service.createFolder("library");

    const sourcePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(sourcePath, "notes");
    await service.addPaths([sourcePath], { destinationDirectory: path.join("projects", "assets") });

    const rootSnapshot = JSON.parse(JSON.stringify(service.state.archiveSession.root));
    await service.renameEntry("folder:projects", "work");
    await service.moveEntry(`folder:${path.join("work", "assets")}`, "library");

    const archiveKey = Buffer.from(service.state.archiveSession.archiveKey);
    const committedRoot = JSON.parse(JSON.stringify(service.state.archiveSession.root));
    const journal = {
      version: 1,
      type: "metadata-mutation",
      state: "pending",
      startedAt: new Date().toISOString(),
      archiveId: committedRoot.archiveId,
      rootSnapshotUpdatedAt: rootSnapshot.updatedAt,
      rootSnapshot,
      targetRootUpdatedAt: committedRoot.updatedAt,
      targetRootDigest: hashRoot(committedRoot),
      trackedEntryCatalogs: {}
    };

    await service.closeArchive();
    await writeMutationJournal(archivePath, archiveKey, journal);
    assert.deepEqual(await readMutationJournal(archivePath, archiveKey), journal);
    await fs.rm(entrySummaryIndexPath(archivePath), { force: true });

    await service.openArchive({ archivePath, password: "password" });
    let rootListing = await service.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(rootListing.items.map((entry) => entry.relativePath), ["library", "work"]);
    assert.equal(await service.folderExists("projects"), false);
    assert.equal(await service.folderExists("work"), true);

    let libraryListing = await service.listEntries({
      directory: "library",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(libraryListing.items.map((entry) => entry.relativePath), ["library/assets"]);

    let assetsListing = await service.listEntries({
      directory: path.join("library", "assets"),
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(assetsListing.items.map((entry) => entry.relativePath), [path.join("library", "assets", "notes.txt")]);
    await fs.access(entrySummaryIndexPath(archivePath));

    await reopenWithRecoveredJournal(service, archivePath);
    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm journal recovery reads");
    };

    rootListing = await service.listEntries({
      directory: "",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(rootListing.items.map((entry) => entry.relativePath), ["library", "work"]);
    assert.equal(await service.folderExists("projects"), false);
    assert.equal(await service.folderExists("work"), true);

    libraryListing = await service.listEntries({
      directory: "library",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(libraryListing.items.map((entry) => entry.relativePath), ["library/assets"]);

    assetsListing = await service.listEntries({
      directory: path.join("library", "assets"),
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(assetsListing.items.map((entry) => entry.relativePath), [path.join("library", "assets", "notes.txt")]);
    service.loadEntry = originalLoadEntry;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service rolls back bulk move mutations when persisting the root fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-bulk-move-rollback-"));
  try {
    const { service, archivePath } = await createRollbackTestFixture(tempDir, "bulk-move-rollback-demo");
    await service.createFolder("docs");
    await service.createFolder(path.join("docs", "nested"));
    await service.createFolder("library");

    const alphaPath = path.join(tempDir, "alpha.txt");
    const betaPath = path.join(tempDir, "beta.txt");
    await fs.writeFile(alphaPath, "alpha");
    await fs.writeFile(betaPath, "beta");
    await service.addPaths([alphaPath, betaPath], { destinationDirectory: "docs" });

    const docsListing = await service.listEntries({
      directory: "docs",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    const alphaEntry = docsListing.items.find((entry) => entry.entryType === "file" && entry.name === "alpha.txt");
    assert.ok(alphaEntry);

    const originalPersistRoot = stubPersistRootFailure(service);
    await assert.rejects(
      () => service.moveEntries([alphaEntry.id, `folder:${path.join("docs", "nested")}`], "library"),
      /persist failed/
    );
    service.persistRoot = originalPersistRoot;

    await reopenRollbackArchive(service, archivePath);
    const originalLoadEntry = service.loadEntry.bind(service);
    service.loadEntry = async () => {
      throw new Error("loadEntry should not run for warm query-index reads");
    };

    const restoredDocsListing = await service.listEntries({
      directory: "docs",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.deepEqual(restoredDocsListing.items.map((entry) => entry.name), ["nested", "alpha.txt", "beta.txt"]);

    const libraryListing = await service.listEntries({
      directory: "library",
      offset: 0,
      limit: 10,
      sortColumn: "name",
      sortDirection: "asc"
    });
    assert.equal(libraryListing.total, 0);
    service.loadEntry = originalLoadEntry;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service emits upload totals once the input set is known", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-progress-total-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const progressEvents = [];
    const service = new ArchiveService(state, createEmitters({
      emitProgress: (payload) => progressEvents.push(payload)
    }));
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "progress-total-demo",
      password: "password",
      preferences: state.settings
    });

    const firstSourcePath = path.join(tempDir, "first.txt");
    const secondSourcePath = path.join(tempDir, "second.txt");
    await fs.writeFile(firstSourcePath, "one");
    await fs.writeFile(secondSourcePath, "two");

    await service.addPaths([firstSourcePath, secondSourcePath]);

    assert.ok(progressEvents.length >= 3);
    assert.equal(progressEvents[0].phase, "preparing");
    assert.equal(progressEvents[0].totalFiles, 2);
    assert.ok(progressEvents.every((event) => event.totalFiles === 2));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service precomputes image previews during ingest", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-previews-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "preview-source.png");
    await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 3,
        background: { r: 48, g: 92, b: 160 }
      }
    })
      .png()
      .toFile(sourcePath);

    await service.addPaths([sourcePath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    const detail = await service.getEntryDetail(listing.items[0].id);
    const revisionId = detail.revisions[0].id;
    const previewRoot = path.join(state.previewCachePath, state.archiveSession.root.archiveId, detail.id, revisionId);

    await fs.access(path.join(previewRoot, "thumbnail.json"));
    await fs.access(path.join(previewRoot, "preview.json"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service refreshes preview descriptors after same-revision optimization updates", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-preview-refresh-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "preview-refresh-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "refresh-source.png");
    await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 80, g: 116, b: 168 }
      }
    })
      .png()
      .toFile(sourcePath);

    await service.addPaths([sourcePath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    const detail = await service.getEntryDetail(listing.items[0].id);
    const before = await service.resolveEntryPreview(detail.id, "preview");
    assert.ok(before?.updatedAt);

    await service.waitForOptimizationQueue();

    const after = await service.resolveEntryPreview(detail.id, "preview");
    assert.ok(after);
    assert.ok(after?.updatedAt);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service can re-import an exported optimized jpeg xl artifact", async (t) => {
  try {
    await runCommand("djxl", ["--version"]);
    await runCommand("cjxl", ["--version"]);
  } catch (_error) {
    t.skip("jpeg xl tools are not available");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-jxl-roundtrip-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.capabilities = {
      ...(state.capabilities || {}),
      djxl: { available: true, path: "djxl" },
      cjxl: { available: true, path: "cjxl" }
    };
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "jxl-roundtrip-demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "roundtrip-source.png");
    await sharp({
      create: {
        width: 960,
        height: 540,
        channels: 3,
        background: { r: 52, g: 128, b: 196 }
      }
    })
      .png()
      .toFile(sourcePath);

    await service.addPaths([sourcePath]);
    await service.waitForOptimizationQueue();

    const firstListing = await service.listEntries({ offset: 0, limit: 10 });
    const sourceDetail = await service.getEntryDetail(firstListing.items[0].id);
    assert.equal(sourceDetail.exportable, true);

    const exportDir = path.join(tempDir, "exports");
    await fs.mkdir(exportDir);
    await service.exportEntry(sourceDetail.id, exportDir);

    const exportedPath = path.join(exportDir, "roundtrip-source.jxl");
    await fs.access(exportedPath);

    await service.addPaths([exportedPath]);
    await service.waitForOptimizationQueue();

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 2);
    const imported = listing.items.find((item) => item.name === "roundtrip-source.jxl");
    assert.ok(imported);

    const importedDetail = await service.getEntryDetail(imported.id);
    assert.equal(importedDetail.fileKind, "image");
    const preview = await service.resolveEntryPreview(imported.id, "preview");
    assert.ok(preview);
    assert.match(preview.mime, /^image\//);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("locking an archive removes plaintext preview artifacts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-lock-cleanup-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await service.createArchive({
      parentPath: tempDir,
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "lock-preview-source.png");
    await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: { r: 80, g: 48, b: 32 }
      }
    })
      .png()
      .toFile(sourcePath);

    await service.addPaths([sourcePath]);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    const detail = await service.getEntryDetail(listing.items[0].id);
    const previewRoot = path.join(state.previewCachePath, state.archiveSession.root.archiveId, detail.id, detail.revisions[0].id);
    await fs.access(path.join(previewRoot, "preview.json"));

    await service.lockArchive();

    await assert.rejects(() => fs.access(previewRoot), /ENOENT/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("opening a legacy archive fails fast", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-legacy-test-"));
  try {
    const archivePath = path.join(tempDir, "legacy.stow");
    await fs.mkdir(archivePath);
    await fs.writeFile(
      path.join(archivePath, "manifest.json"),
      JSON.stringify({
        version: 2,
        encryption: {}
      })
    );

    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };
    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    await assert.rejects(
      () => service.openArchive({ archivePath, password: "password" }),
      /Unsupported archive version/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("archive service refuses to delete non-archive directories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-delete-guard-"));
  try {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.installStatus = {
      active: false,
      phase: "complete",
      message: "ready",
      currentTarget: null,
      completedSteps: 1,
      totalSteps: 1,
      installed: [],
      skipped: []
    };

    const service = new ArchiveService(state, createEmitters());
    await service.initialize();

    const arbitraryDir = path.join(tempDir, "not-an-archive.stow");
    await fs.mkdir(arbitraryDir);

    await assert.rejects(() => service.deleteArchive(arbitraryDir), /not a valid Stow archive/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
