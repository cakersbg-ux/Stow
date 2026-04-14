const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createArchiveEncryption, encryptPayload } = require("./crypto");
const {
  createArchiveCatalog,
  entrySummaryIndexPath,
  deleteMutationJournal,
  loadArchiveCatalog,
  mutationJournalPath,
  readEntryCatalog,
  readEntrySummaryIndex,
  readMutationJournal,
  readObjectBucketCatalog,
  writeEntryCatalog,
  writeEntrySummaryIndex,
  writeMutationJournal,
  writeObjectBucketCatalog
} = require("./catalogStore");

const TEST_ENTRY_ID = "550e8400-e29b-41d4-a716-446655440000";

function loadFreshCatalogStore() {
  delete require.cache[require.resolve("./catalogStore")];
  return require("./catalogStore");
}

async function writeRawEncryptedJson(filePath, archiveKey, value) {
  const encrypted = await encryptPayload(Buffer.from(JSON.stringify(value), "utf8"), archiveKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      header: encrypted.header,
      wrappedKey: encrypted.wrappedKey,
      ciphertext: Buffer.from(encrypted.ciphertext).toString("base64")
    })
  );
}

test("catalog store persists encrypted root, entry shards, and object buckets", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(archivePath);
    const encryption = await createArchiveEncryption("password", "balanced");

    const { manifestEnvelope, root } = await createArchiveCatalog({
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

    const entry = {
      id: TEST_ENTRY_ID,
      name: "file.txt",
      relativePath: "file.txt",
      fileKind: "file",
      mime: "text/plain",
      size: 4,
      createdAt: new Date().toISOString(),
      latestRevisionId: "550e8400-e29b-41d4-a716-446655440001",
      revisions: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          addedAt: new Date().toISOString(),
          source: {
            relativePath: "file.txt",
            size: 4
          },
          media: {},
          overrideMode: null,
          summary: "stored fixture entry",
          actions: ["fixture"],
          originalArtifact: {
            label: "original",
            extension: ".txt",
            mime: "text/plain",
            size: 4,
            contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            chunks: [
              {
                hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                size: 4
              }
            ]
          },
          optimizedArtifact: null
        }
      ]
    };
    await writeEntryCatalog(archivePath, encryption.archiveKey, entry);
    const summaryIndex = {
      version: 1,
      entries: {
        [entry.id]: {
          id: entry.id,
          name: entry.name,
          relativePath: entry.relativePath,
          fileKind: entry.fileKind
        }
      }
    };
    const mutationJournal = {
      version: 1,
      operations: [{ type: "rename", entryId: entry.id, nextName: "renamed.txt" }]
    };
    await writeEntrySummaryIndex(archivePath, encryption.archiveKey, summaryIndex);
    await writeMutationJournal(archivePath, encryption.archiveKey, mutationJournal);
    const bucket = await readObjectBucketCatalog(archivePath, encryption.archiveKey, "aa");
    bucket.objects.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa = {
      hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      storageId: "00112233445566778899aabbccddeeff",
      size: 4,
      storedSize: 4,
      refCount: 1,
      compression: { algorithm: "none", level: 0 },
      crypto: {
        header: {},
        wrappedKey: ""
      }
    };
    await writeObjectBucketCatalog(archivePath, encryption.archiveKey, "aa", bucket);

    const loaded = await loadArchiveCatalog(archivePath, encryption.archiveKey);
    const loadedEntry = await readEntryCatalog(archivePath, encryption.archiveKey, entry.id);
    const loadedSummaryIndex = await readEntrySummaryIndex(archivePath, encryption.archiveKey);
    const loadedMutationJournal = await readMutationJournal(archivePath, encryption.archiveKey);
    const loadedBucket = await readObjectBucketCatalog(archivePath, encryption.archiveKey, "aa");

    assert.equal(loaded.manifestEnvelope.version, manifestEnvelope.version);
    assert.equal(loaded.manifestEnvelope.catalog.entrySummaryIndex, "catalog/entry-summary.enc");
    assert.equal(loaded.manifestEnvelope.catalog.mutationJournal, "catalog/mutation-journal.enc");
    assert.equal(loaded.root.archiveId, root.archiveId);
    assert.equal(loadedEntry.id, entry.id);
    assert.equal(loadedSummaryIndex.entries[entry.id].name, entry.name);
    assert.equal(loadedMutationJournal.operations[0].entryId, entry.id);
    assert.equal(
      loadedBucket.objects.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.refCount,
      1
    );
    assert.equal(entrySummaryIndexPath(archivePath), path.join(archivePath, "catalog", "entry-summary.enc"));
    assert.equal(mutationJournalPath(archivePath), path.join(archivePath, "catalog", "mutation-journal.enc"));

    await deleteMutationJournal(archivePath);
    await assert.rejects(
      () => readMutationJournal(archivePath, encryption.archiveKey),
      /ENOENT/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store treats corrupted object buckets as fatal", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-corrupt-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(path.join(archivePath, "catalog", "objects"), { recursive: true });
    const encryption = await createArchiveEncryption("password", "balanced");

    await fs.writeFile(path.join(archivePath, "catalog", "objects", "aa.enc"), "{not-json");

    await assert.rejects(
      () => readObjectBucketCatalog(archivePath, encryption.archiveKey, "aa"),
      /unreadable or corrupt/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store rejects manifest catalog root traversal before resolving host paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-traversal-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(archivePath);
    await fs.writeFile(
      path.join(archivePath, "manifest.json"),
      JSON.stringify({
        version: 3,
        encryption: {},
        catalog: {
          root: "../outside/root.enc",
          entriesDir: "catalog/entries",
          entrySummaryIndex: "catalog/entry-summary.enc",
          objectBucketsDir: "catalog/objects"
        }
      })
    );

    const encryption = await createArchiveEncryption("password", "balanced");

    await assert.rejects(
      () => loadArchiveCatalog(archivePath, encryption.archiveKey),
      /Unsafe archive manifest: catalog\.root must be catalog\/root\.enc/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store rejects manifest catalog entry summary traversal before resolving host paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-summary-traversal-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(archivePath);
    await fs.writeFile(
      path.join(archivePath, "manifest.json"),
      JSON.stringify({
        version: 3,
        encryption: {},
        catalog: {
          root: "catalog/root.enc",
          entriesDir: "catalog/entries",
          entrySummaryIndex: "../outside/summary.enc",
          objectBucketsDir: "catalog/objects"
        }
      })
    );

    const encryption = await createArchiveEncryption("password", "balanced");

    await assert.rejects(
      () => loadArchiveCatalog(archivePath, encryption.archiveKey),
      /Unsafe archive manifest: catalog\.entrySummaryIndex must be catalog\/entry-summary\.enc/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store rejects manifest catalog mutation journal traversal before resolving host paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-journal-traversal-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(archivePath);
    await fs.writeFile(
      path.join(archivePath, "manifest.json"),
      JSON.stringify({
        version: 3,
        encryption: {},
        catalog: {
          root: "catalog/root.enc",
          entriesDir: "catalog/entries",
          entrySummaryIndex: "catalog/entry-summary.enc",
          mutationJournal: "../outside/journal.enc",
          objectBucketsDir: "catalog/objects"
        }
      })
    );

    const encryption = await createArchiveEncryption("password", "balanced");

    await assert.rejects(
      () => loadArchiveCatalog(archivePath, encryption.archiveKey),
      /Unsafe archive manifest: catalog\.mutationJournal must be catalog\/mutation-journal\.enc/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store rejects unsafe entry ids before using them in file paths", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-entryid-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(archivePath);
    const encryption = await createArchiveEncryption("password", "balanced");

    await assert.rejects(
      () => readEntryCatalog(archivePath, encryption.archiveKey, "../../outside"),
      /Unsafe archive entry metadata/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store rejects crafted entry metadata during read before callers can trust it", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-catalog-entry-validation-test-"));
  try {
    const archivePath = path.join(tempDir, "sample.stow");
    await fs.mkdir(path.join(archivePath, "catalog", "entries"), { recursive: true });
    const encryption = await createArchiveEncryption("password", "balanced");
    const entryPath = path.join(archivePath, "catalog", "entries", `${TEST_ENTRY_ID}.enc`);

    await writeRawEncryptedJson(entryPath, encryption.archiveKey, {
      id: TEST_ENTRY_ID,
      name: "safe.txt",
      relativePath: "../escape.txt",
      fileKind: "file",
      mime: "text/plain",
      size: 4,
      createdAt: new Date().toISOString(),
      latestRevisionId: "550e8400-e29b-41d4-a716-446655440001",
      revisions: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          addedAt: new Date().toISOString(),
          source: {
            relativePath: "../escape.txt",
            size: 4
          },
          media: {},
          overrideMode: null,
          summary: "bad",
          actions: ["bad"],
          originalArtifact: {
            label: "original",
            extension: ".txt",
            mime: "text/plain",
            size: 4,
            contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            chunks: [
              {
                hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                size: 4
              }
            ]
          },
          optimizedArtifact: null
        }
      ]
    });

    await assert.rejects(
      () => readEntryCatalog(archivePath, encryption.archiveKey, TEST_ENTRY_ID),
      /Archive path is invalid|archive entry/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("catalog store zeroizes encrypted wrapper and decrypted plaintext buffers", async () => {
  const fsPromises = require("node:fs/promises");
  const crypto = require("./crypto");
  const wrapperBuffer = Buffer.from(
    JSON.stringify({
      header: { algorithm: "xchacha20poly1305" },
      wrappedKey: { nonce: "AA==", ciphertext: "AQ==" },
      ciphertext: Buffer.from("journal payload", "utf8").toString("base64")
    }),
    "utf8"
  );
  const plaintextBuffer = Buffer.from(JSON.stringify({ version: 1, operations: [] }), "utf8");

  mock.method(fsPromises, "readFile", async () => wrapperBuffer);
  mock.method(crypto, "decryptPayload", async () => plaintextBuffer);

  const catalogStore = loadFreshCatalogStore();
  const journal = await catalogStore.readMutationJournal("/archive/sample.stow", Buffer.alloc(32));

  assert.equal(journal.version, 1);
  assert.deepEqual(Array.from(wrapperBuffer), new Array(wrapperBuffer.length).fill(0));
  assert.deepEqual(Array.from(plaintextBuffer), new Array(plaintextBuffer.length).fill(0));
});
