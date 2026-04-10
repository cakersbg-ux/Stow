const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chunkFile } = require("./chunker");

test("chunkFile yields bounded chunks that reconstruct the source", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-chunker-test-"));
  try {
    const filePath = path.join(tempDir, "sample.bin");
    const source = Buffer.alloc(3 * 1024 * 1024 + 137);
    for (let index = 0; index < source.length; index += 1) {
      source[index] = index % 251;
    }
    await fs.writeFile(filePath, source);

    const chunks = [];
    for await (const chunk of chunkFile(filePath)) {
      assert.ok(chunk.length > 0);
      assert.ok(chunk.length <= 4 * 1024 * 1024);
      chunks.push(chunk.buffer);
    }

    assert.ok(chunks.length >= 1);
    assert.deepEqual(Buffer.concat(chunks), source);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
