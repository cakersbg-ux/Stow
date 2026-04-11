const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

async function walkFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

async function measureDirBytes(dirPath) {
  const files = await walkFiles(dirPath);
  let total = 0;
  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

class PreviewCache {
  constructor(options) {
    this.baseDir = options.baseDir;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.currentBytes = 0;
  }

  async initialize() {
    await ensureDir(this.baseDir);
    await this.cleanup();
  }

  previewDir(key) {
    return path.join(this.baseDir, key.archiveId, key.entryId, key.revisionId);
  }

  metadataPath(key) {
    return path.join(this.previewDir(key), `${key.kind}.json`);
  }

  async getDescriptor(key) {
    const metadataPath = this.metadataPath(key);
    if (!(await exists(metadataPath))) {
      return null;
    }

    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      const descriptor = JSON.parse(raw);
      const stat = await fs.stat(descriptor.path);
      if (Date.now() - stat.mtimeMs > this.maxAgeMs) {
        await this.deletePreviewDir(key);
        return null;
      }
      const now = new Date();
      await fs.utimes(descriptor.path, now, now).catch(() => {});
      await fs.utimes(metadataPath, now, now).catch(() => {});
      return descriptor;
    } catch (_error) {
      await this.deletePreviewDir(key);
      return null;
    }
  }

  async writeDescriptor(key, descriptor) {
    const dir = this.previewDir(key);
    const beforeBytes = await measureDirBytes(dir).catch(() => 0);
    await ensureDir(dir);
    await fs.writeFile(this.metadataPath(key), JSON.stringify(descriptor, null, 2));
    const afterBytes = await measureDirBytes(dir).catch(() => beforeBytes);
    this.currentBytes = Math.max(0, this.currentBytes - beforeBytes + afterBytes);
    if (this.currentBytes > this.maxBytes) {
      await this.cleanup();
    }
    return descriptor;
  }

  async deletePreviewDir(key) {
    const removedBytes = await measureDirBytes(this.previewDir(key)).catch(() => 0);
    await fs.rm(this.previewDir(key), { recursive: true, force: true }).catch(() => {});
    this.currentBytes = Math.max(0, this.currentBytes - removedBytes);
  }

  async cleanup() {
    await ensureDir(this.baseDir);
    const files = await walkFiles(this.baseDir);
    const stats = [];
    let totalBytes = 0;

    for (const filePath of files) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat?.isFile()) {
        continue;
      }

      if (Date.now() - stat.mtimeMs > this.maxAgeMs) {
        await fs.rm(filePath, { force: true }).catch(() => {});
        continue;
      }

      totalBytes += stat.size;
      stats.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }

    this.currentBytes = totalBytes;
    if (totalBytes <= this.maxBytes) {
      return;
    }

    stats.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const stat of stats) {
      if (totalBytes <= this.maxBytes) {
        break;
      }
      await fs.rm(stat.filePath, { force: true }).catch(() => {});
      totalBytes -= stat.size;
    }
    this.currentBytes = Math.max(0, totalBytes);
  }
}

module.exports = {
  PreviewCache
};
