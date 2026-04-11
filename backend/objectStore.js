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
const { encryptPayload, decryptPayload } = require("./crypto");
const { readObjectBucketCatalog, writeObjectBucketCatalog } = require("./catalogStore");

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

function storageIdToPath(baseDir, storageId) {
  return path.join(baseDir, "objects", storageId.slice(0, 2), `${storageId.slice(2)}.bin`);
}

function createStorageId() {
  return uuid().replace(/-/g, "");
}

async function ensureParent(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function runCommand(command, args, inputBuffer) {
  return new Promise((resolve, reject) => {
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
  if (options.compressible === false || buffer.length < 64 * 1024) {
    return { buffer, compression: { algorithm: "none", level: 0 } };
  }
  if (behavior === "max" && safeCapabilities.lzma2Offline?.available) {
    const compressed = await runCommand("7z", ["a", "-an", "-txz", "-mx=9", "-si", "-so"], buffer);
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
  const compressed = await runCommand("zstd", args, buffer);
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

async function decompressBuffer(buffer, compression) {
  if (!compression || compression.algorithm === "none") {
    return buffer;
  }
  if (compression.algorithm === "xz-lzma2") {
    return runCommand("7z", ["x", "-an", "-txz", "-si", "-so"], buffer);
  }
  return runCommand("zstd", ["-q", "-d", "--stdout"], buffer);
}

class ObjectStore {
  constructor(session, capabilities) {
    this.session = session;
    this.capabilities = capabilities;
    this.bucketCache = new Map();
    this.dirtyBuckets = new Set();
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

  async flushDirtyBuckets() {
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
        const filePath = storageIdToPath(this.session.path, storageId);
        await ensureParent(filePath);
        await fsp.writeFile(filePath, encrypted.ciphertext);

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
          },
          file: path.relative(this.session.path, filePath)
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

      const encrypted = await fsp.readFile(path.join(this.session.path, object.file));
      const decrypted = await decryptPayload(
        {
          header: object.crypto.header,
          wrappedKey: object.crypto.wrappedKey,
          ciphertext: encrypted
        },
        this.session.archiveKey
      );
      yield decompressBuffer(decrypted, object.compression);
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
    await this.materializeObjectToFile(descriptor, outputPath);
    return outputPath;
  }

  async releaseArtifact(descriptor) {
    for (const chunkRef of descriptor?.chunks || []) {
      const prefix = chunkRef.hash.slice(0, 2);
      const bucket = await this.loadBucket(prefix);
      const object = bucket.objects[chunkRef.hash];
      if (!object) {
        continue;
      }

      object.refCount = Math.max(0, (object.refCount || 0) - 1);
      if (object.refCount === 0) {
        delete bucket.objects[chunkRef.hash];
        this.session.root.stats.storedObjectCount = Math.max(0, this.session.root.stats.storedObjectCount - 1);
        this.session.root.stats.storedBytes = Math.max(0, this.session.root.stats.storedBytes - object.storedSize);
        await fsp.rm(path.join(this.session.path, object.file), { force: true }).catch(() => {});
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
}

module.exports = {
  ObjectStore,
  createStorageId,
  storageIdToPath
};
