const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function isDirectory(dirPath) {
  const stat = await fs.stat(dirPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function* walkInputPath(inputPath, relativePrefix = path.basename(inputPath)) {
  const stat = await fs.lstat(inputPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Symlinked input paths are not supported: ${inputPath}`);
  }
  if (stat.isFile()) {
    yield {
      absolutePath: inputPath,
      relativePath: relativePrefix,
      size: stat.size
    };
    return;
  }

  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  for (const entry of entries) {
    const absoluteChild = path.join(inputPath, entry.name);
    const childRelative = path.join(relativePrefix, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symlinked input paths are not supported: ${absoluteChild}`);
    }
    if (entry.isDirectory()) {
      yield* walkInputPath(absoluteChild, childRelative);
    } else if (entry.isFile()) {
      const childStat = await fs.lstat(absoluteChild);
      if (childStat.isSymbolicLink()) {
        throw new Error(`Symlinked input paths are not supported: ${absoluteChild}`);
      }
      yield {
        absolutePath: absoluteChild,
        relativePath: childRelative,
        size: childStat.size
      };
    }
  }
}

async function* iterateInputFiles(inputPaths, destinationDirectory = "") {
  for (const inputPath of inputPaths) {
    const relativeRoot = destinationDirectory ? path.join(destinationDirectory, path.basename(inputPath)) : path.basename(inputPath);
    yield* walkInputPath(inputPath, relativeRoot);
  }
}

async function collectInputFiles(inputPaths, destinationDirectory = "") {
  const files = [];
  for await (const file of iterateInputFiles(inputPaths, destinationDirectory)) {
    files.push(file);
  }
  return files;
}

async function withTempDir(prefix, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnOpenFile(filePath) {
  return new Promise((resolve, reject) => {
    let command;
    let args;

    if (process.platform === "darwin") {
      command = "open";
      args = [filePath];
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", filePath];
    } else {
      command = "xdg-open";
      args = [filePath];
    }

    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  collectInputFiles,
  ensureDir,
  exists,
  isDirectory,
  spawnOpenFile,
  withTempDir
};
