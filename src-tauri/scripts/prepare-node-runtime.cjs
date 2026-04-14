#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const isWindows = process.platform === "win32";
const outputName = isWindows ? "node.exe" : "node";
const source = process.env.STOW_NODE_BIN || process.execPath;
const destinationDir = path.resolve(
  process.env.STOW_NODE_RUNTIME_DIR || path.resolve(__dirname, "..", "resources", "node-runtime")
);
const destination = path.join(destinationDir, outputName);
const metadataPath = path.join(destinationDir, "runtime-metadata.json");
const METADATA_VERSION = 1;

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Command failed (${command} ${args.join(" ")}): exit ${code}, stderr: ${stderr.trim()}`
          )
        );
        return;
      }
      resolve(stdout.trim() || stderr.trim());
    });
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const file = await fs.readFile(filePath);
  hash.update(file);
  return hash.digest("hex");
}

async function main() {
  if (process.env.STOW_SKIP_NODE_RUNTIME === "1") {
    console.log("Skipping bundled Node runtime staging (STOW_SKIP_NODE_RUNTIME=1).");
    return;
  }

  await fs.mkdir(destinationDir, { recursive: true });
  await fs.copyFile(source, destination);

  if (!isWindows) {
    await fs.chmod(destination, 0o755);
  }

  const nodeVersion = await runCommand(source, ["--version"]);
  const sha256 = await sha256File(destination);
  const metadata = {
    metadataVersion: METADATA_VERSION,
    binaryName: outputName,
    nodeVersion,
    sha256,
    sourceLabel: path.basename(source),
    stagedAt: new Date().toISOString(),
  };
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  console.log(`Bundled Node runtime staged at ${destination}`);
  console.log(`Bundled runtime metadata written at ${metadataPath}`);
}

main().catch((error) => {
  console.error("Failed to stage bundled Node runtime:", error);
  process.exit(1);
});
