const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { collectArchivesWithinRoot, collectDetectedArchives } = require("./appState");

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
