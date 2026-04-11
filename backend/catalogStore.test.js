const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createArchiveEncryption } = require("./crypto");
const { createArchiveCatalog, loadArchiveCatalog, readObjectBucketCatalog, writeObjectBucketCatalog, writeEntryCatalog, readEntryCatalog } = require("./catalogStore");

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
      id: "entry-1",
      name: "file.txt",
      relativePath: "file.txt",
      fileKind: "file",
      mime: "text/plain",
      size: 4,
      createdAt: new Date().toISOString(),
      latestRevisionId: "revision-1",
      revisions: []
    };
    await writeEntryCatalog(archivePath, encryption.archiveKey, entry);
    const bucket = await readObjectBucketCatalog(archivePath, encryption.archiveKey, "aa");
    bucket.objects.aaaaaaaa = { hash: "aaaaaaaa", refCount: 1 };
    await writeObjectBucketCatalog(archivePath, encryption.archiveKey, "aa", bucket);

    const loaded = await loadArchiveCatalog(archivePath, encryption.archiveKey);
    const loadedEntry = await readEntryCatalog(archivePath, encryption.archiveKey, entry.id);
    const loadedBucket = await readObjectBucketCatalog(archivePath, encryption.archiveKey, "aa");

    assert.equal(loaded.manifestEnvelope.version, manifestEnvelope.version);
    assert.equal(loaded.root.archiveId, root.archiveId);
    assert.equal(loadedEntry.id, entry.id);
    assert.equal(loadedBucket.objects.aaaaaaaa.refCount, 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
