const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function withTempDir(prefix, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

test("prepare-node-runtime stages the bundled runtime and writes metadata in the target directory", async () => {
  await withTempDir("stow-runtime-stage-", async (tempDir) => {
    const scriptPath = path.resolve(__dirname, "prepare-node-runtime.cjs");
    const env = {
      ...process.env,
      STOW_NODE_RUNTIME_DIR: tempDir,
      STOW_NODE_BIN: process.execPath
    };

    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`prepare-node-runtime exited with ${code}: ${stderr.trim()}`));
      });
    });

    const binaryName = process.platform === "win32" ? "node.exe" : "node";
    const binaryPath = path.join(tempDir, binaryName);
    const metadataPath = path.join(tempDir, "runtime-metadata.json");

    const [binary, metadataRaw] = await Promise.all([
      fs.readFile(binaryPath),
      fs.readFile(metadataPath, "utf8")
    ]);
    const metadata = JSON.parse(metadataRaw);

    assert.equal(metadata.metadataVersion, 1);
    assert.equal(metadata.binaryName, binaryName);
    assert.equal(metadata.nodeVersion, process.version);
    assert.equal(metadata.sha256, sha256(binary));
    assert.equal(metadata.sourceLabel, path.basename(process.execPath));
    assert.equal(typeof metadata.stagedAt, "string");
    assert.ok(metadata.stagedAt.length > 0);
  });
});
