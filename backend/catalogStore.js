const fs = require("node:fs/promises");
const path = require("node:path");
const { v4: uuid } = require("uuid");
const { atomicWriteJson } = require("./atomicFile");
const { encryptPayload, decryptPayload, zeroizeBuffer } = require("./crypto");
const { validateEntryRecord, validateObjectBucketCatalog } = require("./archiveMetadata");
const {
  ENTRY_CATALOG_DIR,
  MANIFEST_FILENAME,
  ENTRY_SUMMARY_INDEX_PATH,
  MUTATION_JOURNAL_PATH,
  OBJECT_CATALOG_DIR,
  ROOT_CATALOG_PATH,
  assertValidEntryId,
  assertValidObjectBucketPrefix,
  resolveWithinArchiveRoot,
  validateManifestEnvelope,
  validateRootCatalog
} = require("./archivePathSafety");

const MANIFEST_VERSION = 3;
const LOG_LIMIT = 200;

function normalizeFolderPath(folderPath) {
  if (typeof folderPath !== "string") {
    return null;
  }

  const normalized = path.normalize(folderPath);
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    return null;
  }

  const segments = normalized.split(path.sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return normalized;
}

function normalizeFolderList(folders) {
  if (!Array.isArray(folders)) {
    return [];
  }

  return [...new Set(folders.map(normalizeFolderPath).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function toBase64(value) {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value) {
  return Buffer.from(value, "base64");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await atomicWriteJson(filePath, value);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath);
  try {
    return JSON.parse(raw.toString("utf8"));
  } finally {
    zeroizeBuffer(raw);
  }
}

async function writeEncryptedJson(filePath, value, archiveKey) {
  const encrypted = await encryptPayload(Buffer.from(JSON.stringify(value), "utf8"), archiveKey);
  await ensureDir(path.dirname(filePath));
  await writeJson(filePath, {
    header: encrypted.header,
    wrappedKey: encrypted.wrappedKey,
    ciphertext: toBase64(encrypted.ciphertext)
  });
}

async function readEncryptedJson(filePath, archiveKey) {
  const encrypted = await readJson(filePath);
  const plaintext = await decryptPayload(
    {
      header: encrypted.header,
      wrappedKey: encrypted.wrappedKey,
      ciphertext: fromBase64(encrypted.ciphertext)
    },
    archiveKey
  );

  try {
    return JSON.parse(plaintext.toString("utf8"));
  } finally {
    zeroizeBuffer(plaintext);
  }
}

function createManifestEnvelope(encryptionHeader) {
  return {
    version: MANIFEST_VERSION,
    encryption: encryptionHeader,
    catalog: {
      root: ROOT_CATALOG_PATH,
      entriesDir: ENTRY_CATALOG_DIR,
      entrySummaryIndex: ENTRY_SUMMARY_INDEX_PATH,
      mutationJournal: MUTATION_JOURNAL_PATH,
      objectBucketsDir: OBJECT_CATALOG_DIR
    }
  };
}

function createEmptyRoot(name, preferences) {
  return {
    version: MANIFEST_VERSION,
    archiveId: uuid(),
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    preferences,
    sessionPolicy: {
      idleMinutes: null,
      lockOnHide: null
    },
    folders: [],
    entryOrder: [],
    stats: {
      entryCount: 0,
      storedObjectCount: 0,
      logicalBytes: 0,
      storedBytes: 0
    },
    logs: []
  };
}

function entryCatalogPath(archivePath, entryId) {
  return resolveWithinArchiveRoot(
    archivePath,
    `${ENTRY_CATALOG_DIR}/${assertValidEntryId(entryId)}.enc`,
    "archive entry catalog path"
  );
}

function entrySummaryIndexPath(archivePath) {
  return resolveWithinArchiveRoot(archivePath, ENTRY_SUMMARY_INDEX_PATH, "archive entry summary index path");
}

function mutationJournalPath(archivePath) {
  return resolveWithinArchiveRoot(archivePath, MUTATION_JOURNAL_PATH, "archive mutation journal path");
}

function objectBucketCatalogPath(archivePath, prefix) {
  return resolveWithinArchiveRoot(
    archivePath,
    `${OBJECT_CATALOG_DIR}/${assertValidObjectBucketPrefix(prefix)}.enc`,
    "archive object bucket catalog path"
  );
}

function rootCatalogPath(archivePath) {
  return resolveWithinArchiveRoot(archivePath, ROOT_CATALOG_PATH, "archive root catalog path");
}

function capLogs(logs) {
  return Array.isArray(logs) ? logs.slice(-LOG_LIMIT) : [];
}

async function createArchiveCatalog({ archivePath, encryptionHeader, archiveKey, name, preferences }) {
  const manifestEnvelope = createManifestEnvelope(encryptionHeader);
  const root = createEmptyRoot(name, preferences);

  await ensureDir(resolveWithinArchiveRoot(archivePath, "objects", "archive objects directory"));
  await ensureDir(resolveWithinArchiveRoot(archivePath, ENTRY_CATALOG_DIR, "archive entry catalog directory"));
  await ensureDir(resolveWithinArchiveRoot(archivePath, OBJECT_CATALOG_DIR, "archive object catalog directory"));
  await writeJson(resolveWithinArchiveRoot(archivePath, MANIFEST_FILENAME, "archive manifest path"), manifestEnvelope);
  await writeEncryptedJson(rootCatalogPath(archivePath), root, archiveKey);

  return {
    manifestEnvelope,
    root
  };
}

async function loadArchiveCatalog(archivePath, archiveKey) {
  const manifestEnvelope = validateManifestEnvelope(
    await readJson(resolveWithinArchiveRoot(archivePath, MANIFEST_FILENAME, "archive manifest path")),
    MANIFEST_VERSION
  );
  const root = validateRootCatalog(await readEncryptedJson(rootCatalogPath(archivePath), archiveKey));
  root.logs = capLogs(root.logs);
  root.folders = normalizeFolderList(root.folders);
  return {
    manifestEnvelope,
    root
  };
}

async function saveRootCatalog(archivePath, manifestEnvelope, archiveKey, root) {
  validateManifestEnvelope(manifestEnvelope, MANIFEST_VERSION);
  const nextRoot = {
    ...root,
    version: MANIFEST_VERSION,
    logs: capLogs(root.logs),
    folders: normalizeFolderList(root.folders),
    updatedAt: root.updatedAt || new Date().toISOString()
  };
  await writeEncryptedJson(rootCatalogPath(archivePath), validateRootCatalog(nextRoot), archiveKey);
}

async function readEntryCatalog(archivePath, archiveKey, entryId) {
  return validateEntryRecord(await readEncryptedJson(entryCatalogPath(archivePath, entryId), archiveKey));
}

async function writeEntryCatalog(archivePath, archiveKey, entry) {
  await writeEncryptedJson(entryCatalogPath(archivePath, entry.id), validateEntryRecord(entry), archiveKey);
}

async function readEntrySummaryIndex(archivePath, archiveKey) {
  return readEncryptedJson(entrySummaryIndexPath(archivePath), archiveKey);
}

async function writeEntrySummaryIndex(archivePath, archiveKey, summaryIndex) {
  await writeEncryptedJson(entrySummaryIndexPath(archivePath), summaryIndex, archiveKey);
}

async function readMutationJournal(archivePath, archiveKey) {
  return readEncryptedJson(mutationJournalPath(archivePath), archiveKey);
}

async function writeMutationJournal(archivePath, archiveKey, mutationJournal) {
  await writeEncryptedJson(mutationJournalPath(archivePath), mutationJournal, archiveKey);
}

async function deleteMutationJournal(archivePath) {
  await fs.rm(mutationJournalPath(archivePath), { force: true });
}

async function deleteEntryCatalog(archivePath, entryId) {
  await fs.rm(entryCatalogPath(archivePath, entryId), { force: true });
}

async function readObjectBucketCatalog(archivePath, archiveKey, prefix) {
  try {
    return validateObjectBucketCatalog(
      await readEncryptedJson(objectBucketCatalogPath(archivePath, prefix), archiveKey),
      assertValidObjectBucketPrefix(prefix)
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        version: 1,
        prefix,
        objects: {}
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Object bucket catalog ${prefix} is unreadable or corrupt: ${message}`);
  }
}

async function writeObjectBucketCatalog(archivePath, archiveKey, prefix, bucket) {
  const sanitizedObjects = Object.fromEntries(
    Object.entries(bucket.objects || {}).map(([hash, object]) => {
      if (!object || typeof object !== "object") {
        return [hash, object];
      }

      const { file, ...safeObject } = object;
      return [hash, safeObject];
    })
  );
  const validatedBucket = validateObjectBucketCatalog(
    { version: 1, prefix: assertValidObjectBucketPrefix(prefix), objects: sanitizedObjects },
    assertValidObjectBucketPrefix(prefix)
  );
  await writeEncryptedJson(
    objectBucketCatalogPath(archivePath, prefix),
    validatedBucket,
    archiveKey
  );
}

module.exports = {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  createArchiveCatalog,
  deleteEntryCatalog,
  deleteMutationJournal,
  entryCatalogPath,
  entrySummaryIndexPath,
  loadArchiveCatalog,
  mutationJournalPath,
  objectBucketCatalogPath,
  readEntryCatalog,
  readEntrySummaryIndex,
  readMutationJournal,
  readObjectBucketCatalog,
  saveRootCatalog,
  writeEntryCatalog,
  writeEntrySummaryIndex,
  writeMutationJournal,
  writeObjectBucketCatalog
};
