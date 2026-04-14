const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const { v4: uuid } = require("uuid");
const { chunkFile } = require("./chunker");
const { encryptPayload, decryptPayload, zeroizeBuffer } = require("./crypto");
const { readObjectBucketCatalog, writeObjectBucketCatalog } = require("./catalogStore");
const { assertValidStorageId, resolveWithinArchiveRoot } = require("./archivePathSafety");

const PRECOMPRESSED_EXTENSIONS = new Set([
  ".7z",
  ".aac",
  ".avif",
  ".flac",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".jxl",
  ".m4a",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".rar",
  ".svgz",
  ".webm",
  ".webp",
  ".xz",
  ".zip"
]);

const STAGING_DIRECTORY = "objects/.staging";

function storageIdToPath(baseDir, storageId) {
  const safeStorageId = assertValidStorageId(storageId);
  return resolveWithinArchiveRoot(
    baseDir,
    `objects/${safeStorageId.slice(0, 2)}/${safeStorageId.slice(2)}.bin`,
    "archive object path"
  );
}

function stagedStoragePath(baseDir, storageId) {
  const safeStorageId = assertValidStorageId(storageId);
  return resolveWithinArchiveRoot(
    baseDir,
    `${STAGING_DIRECTORY}/${safeStorageId}.bin.tmp`,
    "archive staged object path"
  );
}

function createStorageId() {
  return uuid().replace(/-/g, "");
}

async function ensureParent(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function runCommand(command, args, inputBuffer) {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args);
      const stdout = [];
      const stderr = [];

      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(stderr).toString() || `${command} failed`));
          return;
        }
        resolve(Buffer.concat(stdout));
      });
      child.stdin.end(inputBuffer);
    });
  } finally {
    zeroizeBuffer(inputBuffer);
  }
}

function shouldCompressArtifact(sourcePath, options = {}) {
  const extension = (options.extension || path.extname(sourcePath)).toLowerCase();
  const mime = (options.mime || "").toLowerCase();

  if (PRECOMPRESSED_EXTENSIONS.has(extension)) {
    return false;
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return false;
  }
  if (mime.startsWith("image/")) {
    return false;
  }
  return true;
}

async function compressBuffer(buffer, behavior, capabilities, options = {}) {
  const safeCapabilities = capabilities || {};
  const lzmaCommand = safeCapabilities.lzma2Offline?.path || "7z";
  const zstdCommand = safeCapabilities.zstd?.path || "zstd";
  if (options.compressible === false || buffer.length < 64 * 1024) {
    return { buffer, compression: { algorithm: "none", level: 0 } };
  }
  if (behavior === "max" && safeCapabilities.lzma2Offline?.available) {
    const compressed = await runCommand(lzmaCommand, ["a", "-an", "-txz", "-mx=9", "-si", "-so"], buffer);
    if (compressed.length < buffer.length) {
      return {
        buffer: compressed,
        compression: {
          algorithm: "xz-lzma2",
          level: 9
        }
      };
    }
  }

  if (!safeCapabilities.zstd?.available) {
    return { buffer, compression: { algorithm: "none", level: 0 } };
  }

  const argsByBehavior = {
    fast: ["-q", "-T1", "-3", "--stdout"],
    balanced: ["-q", "-T1", "-5", "--stdout"],
    max: ["-q", "-T1", "-9", "--stdout"]
  };
  const args = argsByBehavior[behavior] ?? argsByBehavior.balanced;
  const compressed = await runCommand(zstdCommand, args, buffer);
  if (compressed.length >= buffer.length) {
    return { buffer, compression: { algorithm: "none", level: 0 } };
  }

  return {
    buffer: compressed,
    compression: {
      algorithm: "zstd",
      level: Number(args.find((item) => /^-\d+$/.test(item))?.slice(1) || 0)
    }
  };
}

async function decompressBuffer(buffer, compression, capabilities = {}) {
  if (!compression || compression.algorithm === "none") {
    return Buffer.from(buffer);
  }
  if (compression.algorithm === "xz-lzma2") {
    return runCommand(capabilities.lzma2Offline?.path || "7z", ["x", "-an", "-txz", "-si", "-so"], buffer);
  }
  return runCommand(capabilities.zstd?.path || "zstd", ["-q", "-d", "--stdout"], buffer);
}

class ObjectStore {
  constructor(session, capabilities) {
    this.session = session;
    this.capabilities = capabilities;
    this.bucketCache = new Map();
    this.dirtyBuckets = new Set();
    this.pendingWrites = new Map();
  }

  async loadBucket(prefix) {
    if (!this.bucketCache.has(prefix)) {
      const bucket = await readObjectBucketCatalog(this.session.path, this.session.archiveKey, prefix);
      this.bucketCache.set(prefix, bucket);
    }
    return this.bucketCache.get(prefix);
  }

  markBucketDirty(prefix) {
    this.dirtyBuckets.add(prefix);
  }

  async stageObjectWrite(storageId, ciphertext) {
    const filePath = stagedStoragePath(this.session.path, storageId);
    await ensureParent(filePath);
    await fsp.writeFile(filePath, ciphertext);
    this.pendingWrites.set(storageId, filePath);
  }

  async finalizePendingWrites() {
    for (const [storageId, stagedPath] of this.pendingWrites.entries()) {
      const finalPath = storageIdToPath(this.session.path, storageId);
      await ensureParent(finalPath);
      await fsp.rename(stagedPath, finalPath);
    }
    this.pendingWrites.clear();
  }

  async discardPendingWrites() {
    for (const stagedPath of this.pendingWrites.values()) {
      await fsp.rm(stagedPath, { force: true }).catch(() => {});
    }
    this.pendingWrites.clear();
  }

  async flushDirtyBuckets() {
    await this.finalizePendingWrites();
    for (const prefix of this.dirtyBuckets) {
      const bucket = this.bucketCache.get(prefix);
      if (!bucket) {
        continue;
      }
      await writeObjectBucketCatalog(this.session.path, this.session.archiveKey, prefix, bucket);
    }
    this.dirtyBuckets.clear();
  }

  async storeFile(sourcePath, behavior, options = {}) {
    const refs = [];
    let newChunks = 0;
    let reusedChunks = 0;
    let storedBytes = 0;
    let totalSize = 0;
    const contentHash = crypto.createHash("sha256");
    const compressible = shouldCompressArtifact(sourcePath, options);

    for await (const chunk of chunkFile(sourcePath)) {
      const prefix = chunk.hash.slice(0, 2);
      const bucket = await this.loadBucket(prefix);
      let object = bucket.objects[chunk.hash];

      contentHash.update(chunk.buffer);
      totalSize += chunk.buffer.length;

      if (!object) {
        const compressed = await compressBuffer(chunk.buffer, behavior, this.capabilities, { compressible });
        const encrypted = await encryptPayload(compressed.buffer, this.session.archiveKey);
        const storageId = createStorageId();
        await this.stageObjectWrite(storageId, encrypted.ciphertext);

        object = {
          hash: chunk.hash,
          storageId,
          size: chunk.buffer.length,
          storedSize: encrypted.ciphertext.length,
          refCount: 0,
          compression: compressed.compression,
          crypto: {
            header: encrypted.header,
            wrappedKey: encrypted.wrappedKey
          }
        };
        bucket.objects[chunk.hash] = object;
        this.session.root.stats.storedObjectCount += 1;
        this.session.root.stats.storedBytes += encrypted.ciphertext.length;
        newChunks += 1;
        storedBytes += encrypted.ciphertext.length;
      } else {
        reusedChunks += 1;
      }

      object.refCount += 1;
      this.markBucketDirty(prefix);
      refs.push({
        hash: chunk.hash,
        size: chunk.length
      });
    }

    await this.flushDirtyBuckets();

    return {
      contentHash: contentHash.digest("hex"),
      size: totalSize,
      chunks: refs,
      storageStats: {
        totalChunks: refs.length,
        newChunks,
        reusedChunks,
        storedBytes
      }
    };
  }

  async *iterateObjectBuffers(descriptor) {
    for (const chunkRef of descriptor.chunks || []) {
      const prefix = chunkRef.hash.slice(0, 2);
      const bucket = await this.loadBucket(prefix);
      const object = bucket.objects[chunkRef.hash];
      if (!object) {
        throw new Error(`Chunk ${chunkRef.hash} is missing from the archive object store`);
      }

      const encrypted = await fsp.readFile(storageIdToPath(this.session.path, object.storageId));
      try {
        const decrypted = await decryptPayload(
          {
            header: object.crypto.header,
            wrappedKey: object.crypto.wrappedKey,
            ciphertext: encrypted
          },
          this.session.archiveKey
        );
        try {
          yield await decompressBuffer(decrypted, object.compression, this.capabilities);
        } finally {
          zeroizeBuffer(decrypted);
        }
      } finally {
        zeroizeBuffer(encrypted);
      }
    }
  }

  openObjectReadStream(descriptor) {
    return Readable.from(this.iterateObjectBuffers(descriptor));
  }

  async materializeObjectToFile(descriptor, outputPath) {
    await ensureParent(outputPath);
    const output = fs.createWriteStream(outputPath);
    await pipeline(this.openObjectReadStream(descriptor), output);
    return outputPath;
  }

  async materializeObjectToTempPath(descriptor, extension = "", prefix = "stow-materialized-") {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    const outputPath = path.join(tempDir, `artifact${extension}`);
    try {
      await this.materializeObjectToFile(descriptor, outputPath);
      return outputPath;
    } catch (error) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async releaseArtifact(descriptor) {
    for (const chunkRef of descriptor?.chunks || []) {
      const prefix = chunkRef.hash.slice(0, 2);
      let bucket;
      try {
        bucket = await this.loadBucket(prefix);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Unsafe legacy object metadata")) {
          continue;
        }
        throw error;
      }
      const object = bucket.objects[chunkRef.hash];
      if (!object) {
        continue;
      }

      object.refCount = Math.max(0, (object.refCount || 0) - 1);
      if (object.refCount === 0) {
        delete bucket.objects[chunkRef.hash];
        this.session.root.stats.storedObjectCount = Math.max(0, this.session.root.stats.storedObjectCount - 1);
        this.session.root.stats.storedBytes = Math.max(0, this.session.root.stats.storedBytes - object.storedSize);
        try {
          await fsp.rm(storageIdToPath(this.session.path, object.storageId), { force: true });
        } catch (_error) {
          // Best-effort cleanup. Legacy or malformed metadata may not have a usable storage path.
        }
      }
      this.markBucketDirty(prefix);
    }
  }

  async releaseEntry(entry) {
    for (const revision of entry.revisions || []) {
      await this.releaseArtifact(revision.originalArtifact);
      await this.releaseArtifact(revision.optimizedArtifact);
    }
    await this.flushDirtyBuckets();
  }

  async reconcileStorage() {
    await this.discardPendingWrites();

    const stagingDir = resolveWithinArchiveRoot(this.session.path, STAGING_DIRECTORY, "archive object staging directory");
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});

    const referencedPaths = new Set();
    const objectCatalogDir = resolveWithinArchiveRoot(this.session.path, "catalog/objects", "archive object catalog directory");
    const bucketEntries = await fsp.readdir(objectCatalogDir, { withFileTypes: true }).catch(() => []);
    for (const entry of bucketEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".enc")) {
        continue;
      }
      const prefix = entry.name.slice(0, -4);
      const bucket = await readObjectBucketCatalog(this.session.path, this.session.archiveKey, prefix);
      this.bucketCache.set(prefix, bucket);
      for (const object of Object.values(bucket.objects || {})) {
        referencedPaths.add(storageIdToPath(this.session.path, object.storageId));
      }
    }

    const objectRoot = resolveWithinArchiveRoot(this.session.path, "objects", "archive objects directory");
    const objectDirs = await fsp.readdir(objectRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of objectDirs) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const prefixDir = path.join(objectRoot, entry.name);
      const objectFiles = await fsp.readdir(prefixDir, { withFileTypes: true }).catch(() => []);
      for (const objectFile of objectFiles) {
        if (!objectFile.isFile() || !objectFile.name.endsWith(".bin")) {
          continue;
        }
        const absolutePath = path.join(prefixDir, objectFile.name);
        if (!referencedPaths.has(absolutePath)) {
          await fsp.rm(absolutePath, { force: true }).catch(() => {});
        }
      }
    }
  }
}

module.exports = {
  ObjectStore,
  createStorageId,
  stagedStoragePath,
  storageIdToPath
};
