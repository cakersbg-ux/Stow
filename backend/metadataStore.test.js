const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createArchiveEncryption } = require("./crypto");
const { createArchiveCatalog } = require("./catalogStore");
const { ArchiveQueryIndex } = require("./archiveQueryIndex");
const {
  createMetadataStore,
  JsonMetadataStore,
  SqliteMetadataStore
} = require("./metadataStore");

async function createSession(tempDir) {
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
      stripDerivativeMetadata: true
    }
  });

  const session = {
    path: archivePath,
    archiveKey: encryption.archiveKey,
    manifestEnvelope,
    root,
    queryIndex: new ArchiveQueryIndex(),
    folderSet: new Set(root.folders || [])
  };
  return session;
}

async function runMetadataStoreContract(kind) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-metadata-store-test-"));
  try {
    const session = await createSession(tempDir);
    session.metadataStore = createMetadataStore(session, { kind });
    const entry = {
      id: "550e8400-e29b-41d4-a716-446655440010",
      name: "note.txt",
      relativePath: "note.txt",
      fileKind: "file",
      mime: "text/plain",
      size: 4,
      createdAt: new Date().toISOString(),
      latestRevisionId: "550e8400-e29b-41d4-a716-446655440011",
      revisions: [
        {
          id: "550e8400-e29b-41d4-a716-446655440011",
          addedAt: new Date().toISOString(),
          source: {
            relativePath: "note.txt",
            size: 4
          },
          media: {},
          overrideMode: null,
          summary: "fixture",
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

    await session.metadataStore.upsertEntry(entry);
    session.queryIndex.upsertEntry({
      id: entry.id,
      name: entry.name,
      relativePath: entry.relativePath,
      fileKind: entry.fileKind,
      mime: entry.mime,
      size: entry.size,
      sourceSize: entry.size,
      latestRevisionId: entry.latestRevisionId,
      overrideMode: null,
      previewable: false
    });
    await session.metadataStore.writeSummaryIndex({
      version: 1,
      rootUpdatedAt: session.root.updatedAt,
      entries: {
        [entry.id]: {
          id: entry.id,
          name: entry.name,
          relativePath: entry.relativePath,
          fileKind: entry.fileKind,
          mime: entry.mime,
          size: entry.size,
          sourceSize: entry.size,
          latestRevisionId: entry.latestRevisionId,
          overrideMode: null,
          previewable: false
        }
      }
    });
    await session.metadataStore.writeMutationJournal({
      version: 1,
      type: "metadata-mutation",
      state: "pending",
      archiveId: session.root.archiveId,
      rootSnapshot: session.root,
      trackedEntryCatalogs: {}
    });
    session.root.updatedAt = new Date().toISOString();
    await session.metadataStore.commit({ root: session.root });

    const loadedEntry = await session.metadataStore.getEntryById(entry.id);
    const loadedByPath = await session.metadataStore.getEntryByPath(entry.relativePath);
    const summaryIndex = await session.metadataStore.readSummaryIndex();
    const journal = await session.metadataStore.readMutationJournal();

    assert.equal(loadedEntry.id, entry.id);
    assert.equal(loadedByPath.id, entry.id);
    assert.equal(summaryIndex.entries[entry.id].name, entry.name);
    assert.equal(journal.archiveId, session.root.archiveId);

    await session.metadataStore.deleteEntry(entry.id);
    await assert.rejects(
      session.metadataStore.getEntryById(entry.id),
      /ENOENT|not found|missing/i
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("JsonMetadataStore persists roots, entries, summary indexes, and mutation journals", async () => {
  await runMetadataStoreContract("json");
});

test("SqliteMetadataStore persists roots, entries, summary indexes, and mutation journals", async () => {
  await runMetadataStoreContract("sqlite");
});

test("createMetadataStore honors STOW_METADATA_STORE env default", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-metadata-store-kind-test-"));
  const previous = process.env.STOW_METADATA_STORE;
  try {
    const session = await createSession(tempDir);

    process.env.STOW_METADATA_STORE = "sqlite";
    assert.ok(createMetadataStore(session) instanceof SqliteMetadataStore);

    process.env.STOW_METADATA_STORE = "json";
    assert.ok(createMetadataStore(session) instanceof JsonMetadataStore);

    process.env.STOW_METADATA_STORE = "unexpected";
    assert.ok(createMetadataStore(session) instanceof JsonMetadataStore);
  } finally {
    if (typeof previous === "undefined") {
      delete process.env.STOW_METADATA_STORE;
    } else {
      process.env.STOW_METADATA_STORE = previous;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
