const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { collectArchivesWithinRoot, collectDetectedArchives, createInitialState } = require("./appState");

function loadFreshAppState() {
  const modulePath = require.resolve("./appState");
  delete require.cache[modulePath];
  return require("./appState");
}

async function withTempDir(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-app-state-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createArchiveDir(rootDir, name, manifestValue) {
  const archivePath = path.join(rootDir, `${name}.stow`);
  await fs.mkdir(archivePath, { recursive: true });
  await fs.writeFile(path.join(archivePath, "sample.txt"), "data");
  if (manifestValue !== null) {
    await fs.writeFile(path.join(archivePath, "manifest.json"), manifestValue);
  }
  return archivePath;
}

async function createNestedArchiveDir(rootDir, segments, manifestValue) {
  const archivePath = path.join(rootDir, ...segments, "nested.stow");
  await fs.mkdir(archivePath, { recursive: true });
  await fs.writeFile(path.join(archivePath, "sample.txt"), "data");
  if (manifestValue !== null) {
    await fs.writeFile(path.join(archivePath, "manifest.json"), manifestValue);
  }
  return archivePath;
}

test("archive scans only include supported v3 archives", async () => {
  await withTempDir(async (tempDir) => {
    await createArchiveDir(tempDir, "compatible", JSON.stringify({ version: 3 }));
    await createArchiveDir(tempDir, "legacy", JSON.stringify({ version: 2 }));
    await createArchiveDir(tempDir, "invalid", "{");
    await createArchiveDir(tempDir, "missing", null);

    const recent = await collectArchivesWithinRoot(tempDir);
    const detected = await collectDetectedArchives(tempDir);

    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.name, "compatible");
    assert.equal(recent[0]?.path, path.join(tempDir, "compatible.stow"));

    assert.equal(detected.length, 1);
    assert.equal(detected[0]?.name, "compatible");
    assert.equal(detected[0]?.path, path.join(tempDir, "compatible.stow"));
  });
});

test("detected archive scans are cached and reused without deep traversal", async () => {
  await withTempDir(async (tempDir) => {
    const userDataPath = path.join(tempDir, "user-data");
    const homeArchivePath = await createNestedArchiveDir(tempDir, ["projects", "alpha"], JSON.stringify({ version: 3 }));

    const firstAppState = loadFreshAppState();
    await firstAppState.createInitialState(userDataPath, tempDir);
    const initialDetected = await firstAppState.collectDetectedArchives(tempDir);
    assert.equal(initialDetected.length, 1);
    assert.equal(initialDetected[0]?.path, homeArchivePath);

    const cachePath = path.join(userDataPath, "detected-archives.json");
    const cachedIndex = JSON.parse(await fs.readFile(cachePath, "utf8"));
    assert.equal(cachedIndex.homeDir, tempDir);
    assert.equal(cachedIndex.archives.length, 1);

    const secondAppState = loadFreshAppState();
    await secondAppState.createInitialState(userDataPath, tempDir);

    const originalReaddir = fs.readdir;
    let deepTraversalAttempted = false;
    fs.readdir = async (dirPath, options) => {
      if (dirPath !== tempDir) {
        deepTraversalAttempted = true;
        throw new Error(`unexpected recursive traversal of ${dirPath}`);
      }
      return originalReaddir(dirPath, options);
    };

    try {
      const cachedDetected = await secondAppState.collectDetectedArchives(tempDir);
      assert.equal(cachedDetected.length, 1);
      assert.equal(cachedDetected[0]?.path, homeArchivePath);
      assert.equal(deepTraversalAttempted, false);
    } finally {
      fs.readdir = originalReaddir;
    }
  });
});

test("initial state exposes the current settings schema", async () => {
  await withTempDir(async (tempDir) => {
    const state = await createInitialState(path.join(tempDir, "user-data"), tempDir);
    assert.deepEqual(Object.keys(state.settings).sort(), [
      "argonProfile",
      "compressionBehavior",
      "deleteOriginalFilesAfterSuccessfulUpload",
      "optimizationMode",
      "preferredArchiveRoot",
      "sessionIdleMinutes",
      "sessionLockOnHide",
      "stripDerivativeMetadata",
      "themePreference"
    ]);
  });
});

test("initial state normalizes persisted settings", async () => {
  await withTempDir(async (tempDir) => {
    const userDataPath = path.join(tempDir, "user-data");
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(
      path.join(userDataPath, "settings.json"),
      JSON.stringify({
        sessionIdleMinutes: "bad",
        preferredArchiveRoot: ""
      })
    );

    const state = await createInitialState(userDataPath, tempDir);
    assert.equal(state.settings.sessionIdleMinutes, 0);
    assert.equal(state.settings.preferredArchiveRoot, path.join(tempDir, "Stow Archives"));
    assert.equal(state.settings.themePreference, "system");
  });
});

test("initial state loads persisted recent archives and drops missing ones", async () => {
  await withTempDir(async (tempDir) => {
    const userDataPath = path.join(tempDir, "user-data");
    await fs.mkdir(userDataPath, { recursive: true });

    const keptArchivePath = await createArchiveDir(tempDir, "kept", JSON.stringify({ version: 3 }));
    const missingArchivePath = path.join(tempDir, "missing.stow");

    await fs.writeFile(
      path.join(userDataPath, "recent-archives.json"),
      JSON.stringify([
        {
          path: missingArchivePath,
          name: "missing",
          lastOpenedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          path: keptArchivePath,
          name: "kept",
          lastOpenedAt: "2026-02-01T00:00:00.000Z"
        }
      ])
    );

    const state = await createInitialState(userDataPath, tempDir);
    assert.equal(state.recentArchives.length, 1);
    assert.equal(state.recentArchives[0].path, keptArchivePath);
    assert.equal(state.recentArchives[0].name, "kept");
  });
});
