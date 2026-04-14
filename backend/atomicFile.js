const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function createTempPath(filePath) {
  const dirPath = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const suffix = crypto.randomBytes(6).toString("hex");
  return path.join(dirPath, `.${baseName}.${process.pid}.${Date.now()}.${suffix}.tmp`);
}

async function syncPath(filePath) {
  let handle = null;
  try {
    handle = await fs.open(filePath, "r");
    await handle.sync();
  } catch (_error) {
    // Best-effort fsync. Some platforms/filesystems do not support syncing directories.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteFile(filePath, data, options = undefined) {
  const dirPath = path.dirname(filePath);
  const tempPath = createTempPath(filePath);

  await ensureDir(dirPath);
  try {
    await fs.writeFile(tempPath, data, options);
    await syncPath(tempPath);
    await fs.rename(tempPath, filePath);
    await syncPath(dirPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

module.exports = {
  atomicWriteFile,
  atomicWriteJson
};
