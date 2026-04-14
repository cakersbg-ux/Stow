const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { atomicWriteJson } = require("./atomicFile");

test("atomicWriteJson replaces file contents without leaving temp files behind", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-atomic-file-test-"));
  try {
    const targetPath = path.join(tempDir, "settings.json");
    await atomicWriteJson(targetPath, { version: 1, value: "first" });
    await atomicWriteJson(targetPath, { version: 2, value: "second" });

    const parsed = JSON.parse(await fs.readFile(targetPath, "utf8"));
    const entries = await fs.readdir(tempDir);

    assert.deepEqual(parsed, { version: 2, value: "second" });
    assert.deepEqual(entries, ["settings.json"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
