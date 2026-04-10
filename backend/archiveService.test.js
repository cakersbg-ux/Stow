const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { ArchiveService } = require("./archiveService");
const { createInitialState } = require("./appState");

function createEmitters() {
  return {
    emitShellState: () => {},
    emitProgress: () => {},
    emitEntriesInvalidated: () => {}
  };
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
    await service.exportEntry(detail.id, "original", exportDir);
    const exported = await fs.readFile(path.join(exportDir, "hello-original.txt"), "utf8");
    assert.equal(exported, "hello world");

    await service.deleteEntry(detail.id);
    const afterDelete = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(afterDelete.total, 0);
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

test("archive service requests manual classification instead of falling back when upscale routing is unavailable", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-service-test-manual-classify-"));
  const bundledModelPath = path.join(__dirname, "generated", "model_quantized.onnx");
  const bundledModelBackupPath = `${bundledModelPath}.test-backup`;
  try {
    const bundledModelExists = await fs
      .access(bundledModelPath)
      .then(() => true)
      .catch(() => false);
    if (bundledModelExists) {
      await fs.rename(bundledModelPath, bundledModelBackupPath);
    }

    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    state.settings.deleteOriginalFilesAfterSuccessfulUpload = false;
    state.settings.upscaleEnabled = true;
    state.settings.imageTargetResolution = "1080p";
    state.settings.optimizationMode = "visually_lossless";
    state.capabilities.cjxl = {
      available: true,
      path: "cjxl"
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
      name: "demo",
      password: "password",
      preferences: state.settings
    });

    const sourcePath = path.join(tempDir, "small-photo.png");
    await sharp({
      create: {
        width: 320,
        height: 180,
        channels: 3,
        background: { r: 120, g: 148, b: 172 }
      }
    })
      .png()
      .toFile(sourcePath);

    const result = await service.addPaths([sourcePath]);
    assert.equal(result.manualClassificationRequest?.items.length, 1);
    assert.equal(result.manualClassificationRequest?.items[0].absolutePath, sourcePath);

    const listing = await service.listEntries({ offset: 0, limit: 10 });
    assert.equal(listing.total, 0);
  } finally {
    const bundledModelBackupExists = await fs
      .access(bundledModelBackupPath)
      .then(() => true)
      .catch(() => false);
    if (bundledModelBackupExists) {
      await fs.rename(bundledModelBackupPath, bundledModelPath);
    }
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
