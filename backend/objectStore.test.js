const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createArchiveEncryption, encryptPayload } = require("./crypto");
const { createArchiveCatalog, objectBucketCatalogPath } = require("./catalogStore");
const { ObjectStore, stagedStoragePath, storageIdToPath } = require("./objectStore");

const TEST_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_STORAGE_ID = "00112233445566778899aabbccddeeff";

async function createSession(tempDir) {
  const archivePath = path.join(tempDir, "sample.stow");
  await fs.mkdir(archivePath);
  const encryption = await createArchiveEncryption("password", "balanced");
  const { root } = await createArchiveCatalog({
    archivePath,
    encryptionHeader: {
      ...encryption.header,
      profile: "balanced"
    },
    archiveKey: encryption.archiveKey,
    name: "Sample",
    preferences: {
      compressionBehavior: "balanced",
      optimizationMode: "visually_lossless",
      stripDerivativeMetadata: true,
      argonProfile: "balanced",
      preferredArchiveRoot: tempDir,
      sessionIdleMinutes: 0,
      sessionLockOnHide: false
    }
  });

  return {
    archivePath,
    archiveKey: encryption.archiveKey,
    root
  };
}

async function writeRawBucketCatalog(archivePath, archiveKey, prefix, bucket) {
  const encrypted = await encryptPayload(Buffer.from(JSON.stringify(bucket), "utf8"), archiveKey);
  const catalogPath = objectBucketCatalogPath(archivePath, prefix);
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(
    catalogPath,
    JSON.stringify({
      header: encrypted.header,
      wrappedKey: encrypted.wrappedKey,
      ciphertext: Buffer.from(encrypted.ciphertext).toString("base64")
    })
  );
}

test("object store ignores metadata-stored file paths and derives reads from storageId", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-object-read-test-"));
  try {
    const session = await createSession(tempDir);
    const objectPath = storageIdToPath(session.archivePath, TEST_STORAGE_ID);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });

    const payload = Buffer.from("safe archive object", "utf8");
    const encrypted = await encryptPayload(payload, session.archiveKey);
    await fs.writeFile(objectPath, encrypted.ciphertext);

    const victimPath = path.join(tempDir, "victim.bin");
    await fs.writeFile(victimPath, "do-not-read");

    await writeRawBucketCatalog(session.archivePath, session.archiveKey, "aa", {
      version: 1,
      prefix: "aa",
      objects: {
        [TEST_HASH]: {
          hash: TEST_HASH,
          storageId: TEST_STORAGE_ID,
          size: payload.length,
          refCount: 1,
          storedSize: encrypted.ciphertext.length,
          compression: { algorithm: "none", level: 0 },
          crypto: {
            header: encrypted.header,
            wrappedKey: encrypted.wrappedKey
          },
          file: "../../victim.bin"
        }
      }
    });

    const store = new ObjectStore(
      {
        path: session.archivePath,
        archiveKey: session.archiveKey,
        root: {
          ...session.root,
          stats: {
            ...session.root.stats
          }
        }
      },
      {}
    );

    const buffers = [];
    for await (const bufferPromise of store.iterateObjectBuffers({ chunks: [{ hash: TEST_HASH, size: payload.length }] })) {
      buffers.push(await bufferPromise);
    }

    assert.equal(Buffer.concat(buffers).toString("utf8"), payload.toString("utf8"));
    assert.equal(await fs.readFile(victimPath, "utf8"), "do-not-read");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("object store rejects unsafe legacy object metadata without storageId", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-object-legacy-test-"));
  try {
    const session = await createSession(tempDir);
    await writeRawBucketCatalog(session.archivePath, session.archiveKey, "aa", {
      version: 1,
      prefix: "aa",
      objects: {
        [TEST_HASH]: {
          hash: TEST_HASH,
          refCount: 1,
          storedSize: 4,
          compression: { algorithm: "none", level: 0 },
          crypto: {
            header: {},
            wrappedKey: ""
          },
          file: "../../victim.bin"
        }
      }
    });

    const store = new ObjectStore(
      {
        path: session.archivePath,
        archiveKey: session.archiveKey,
        root: session.root
      },
      {}
    );

    await assert.rejects(
      async () => {
        for await (const _buffer of store.iterateObjectBuffers({ chunks: [{ hash: TEST_HASH, size: 4 }] })) {
          // Force iteration.
        }
      },
      /Unsafe legacy object metadata: storageId must be 32 hex characters/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("object store deletes only the storageId-derived object path", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-object-delete-test-"));
  try {
    const session = await createSession(tempDir);
    const objectPath = storageIdToPath(session.archivePath, TEST_STORAGE_ID);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, "encrypted-bytes");

    const victimPath = path.join(tempDir, "victim.bin");
    await fs.writeFile(victimPath, "keep-me");

    await writeRawBucketCatalog(session.archivePath, session.archiveKey, "aa", {
      version: 1,
      prefix: "aa",
      objects: {
        [TEST_HASH]: {
          hash: TEST_HASH,
          storageId: TEST_STORAGE_ID,
          size: 15,
          refCount: 1,
          storedSize: 15,
          compression: { algorithm: "none", level: 0 },
          crypto: {
            header: {},
            wrappedKey: ""
          },
          file: "../../victim.bin"
        }
      }
    });

    const store = new ObjectStore(
      {
        path: session.archivePath,
        archiveKey: session.archiveKey,
        root: {
          ...session.root,
          stats: {
            ...session.root.stats,
            storedObjectCount: 1,
            storedBytes: 15
          }
        }
      },
      {}
    );

    await store.releaseArtifact({ chunks: [{ hash: TEST_HASH, size: 1 }] });
    await store.flushDirtyBuckets();

    await assert.rejects(() => fs.access(objectPath), /ENOENT/);
    assert.equal(await fs.readFile(victimPath, "utf8"), "keep-me");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("object store cleans up a failed temp materialization attempt", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-object-temp-cleanup-test-"));
  try {
    const session = await createSession(tempDir);
    const store = new ObjectStore(
      {
        path: session.archivePath,
        archiveKey: session.archiveKey,
        root: session.root
      },
      {}
    );
    const tempPaths = [];
    const fsPromises = require("node:fs/promises");
    const originalMaterialize = store.materializeObjectToFile;

    mock.method(fsPromises, "mkdtemp", async () => {
      const tempPath = path.join(tempDir, "tmp-materialize");
      tempPaths.push(tempPath);
      await fs.mkdir(tempPath, { recursive: true });
      return tempPath;
    });
    store.materializeObjectToFile = async () => {
      throw new Error("boom");
    };

    try {
      await assert.rejects(() => store.materializeObjectToTempPath({ chunks: [] }, ".txt"), /boom/);

      assert.equal(tempPaths.length, 1);
      await assert.rejects(() => fs.access(tempPaths[0]), /ENOENT/);
    } finally {
      store.materializeObjectToFile = originalMaterialize;
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("object store skips deleting malformed legacy object paths during cleanup", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-object-release-legacy-test-"));
  try {
    const session = await createSession(tempDir);
    await writeRawBucketCatalog(session.archivePath, session.archiveKey, "aa", {
      version: 1,
      prefix: "aa",
      objects: {
        [TEST_HASH]: {
          hash: TEST_HASH,
          refCount: 1,
          storedSize: 15,
          compression: { algorithm: "none", level: 0 },
          crypto: {
            header: {},
            wrappedKey: ""
          }
        }
      }
    });

    const store = new ObjectStore(
      {
        path: session.archivePath,
        archiveKey: session.archiveKey,
        root: {
          ...session.root,
          stats: {
            ...session.root.stats,
            storedObjectCount: 1,
            storedBytes: 15
          }
        }
      },
      {}
    );

    await store.releaseArtifact({ chunks: [{ hash: TEST_HASH, size: 1 }] });
    await store.flushDirtyBuckets();

    const bucket = store.bucketCache.get("aa");
    assert.equal(bucket, undefined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("object store reconcileStorage removes stale staged and unreferenced object files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-object-reconcile-test-"));
  try {
    const session = await createSession(tempDir);
    const store = new ObjectStore(
      {
        path: session.archivePath,
        archiveKey: session.archiveKey,
        root: session.root
      },
      {}
    );

    const stagedPath = stagedStoragePath(session.archivePath, TEST_STORAGE_ID);
    const orphanPath = storageIdToPath(session.archivePath, TEST_STORAGE_ID);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(stagedPath, "staged");
    await fs.writeFile(orphanPath, "orphan");

    await store.reconcileStorage();

    await assert.rejects(() => fs.access(stagedPath), /ENOENT/);
    await assert.rejects(() => fs.access(orphanPath), /ENOENT/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
