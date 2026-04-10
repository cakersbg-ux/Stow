const fs = require("node:fs/promises");
const path = require("node:path");
const { v4: uuid } = require("uuid");
const { encryptPayload, decryptPayload } = require("./crypto");

const MANIFEST_VERSION = 3;
const MANIFEST_FILENAME = "manifest.json";
const ROOT_CATALOG_PATH = path.join("catalog", "root.enc");
const ENTRY_CATALOG_DIR = path.join("catalog", "entries");
const OBJECT_CATALOG_DIR = path.join("catalog", "objects");
const LOG_LIMIT = 200;

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
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
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
  return JSON.parse(plaintext.toString("utf8"));
}

function createManifestEnvelope(encryptionHeader) {
  return {
    version: MANIFEST_VERSION,
    encryption: encryptionHeader,
    catalog: {
      root: ROOT_CATALOG_PATH,
      entriesDir: ENTRY_CATALOG_DIR,
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
  return path.join(archivePath, ENTRY_CATALOG_DIR, `${entryId}.enc`);
}

function objectBucketCatalogPath(archivePath, prefix) {
  return path.join(archivePath, OBJECT_CATALOG_DIR, `${prefix}.enc`);
}

function rootCatalogPath(archivePath, manifestEnvelope) {
  return path.join(archivePath, manifestEnvelope.catalog.root);
}

function capLogs(logs) {
  return Array.isArray(logs) ? logs.slice(-LOG_LIMIT) : [];
}

async function createArchiveCatalog({ archivePath, encryptionHeader, archiveKey, name, preferences }) {
  const manifestEnvelope = createManifestEnvelope(encryptionHeader);
  const root = createEmptyRoot(name, preferences);

  await ensureDir(path.join(archivePath, "objects"));
  await ensureDir(path.join(archivePath, ENTRY_CATALOG_DIR));
  await ensureDir(path.join(archivePath, OBJECT_CATALOG_DIR));
  await writeJson(path.join(archivePath, MANIFEST_FILENAME), manifestEnvelope);
  await writeEncryptedJson(rootCatalogPath(archivePath, manifestEnvelope), root, archiveKey);

  return {
    manifestEnvelope,
    root
  };
}

async function loadArchiveCatalog(archivePath, archiveKey) {
  const manifestEnvelope = await readJson(path.join(archivePath, MANIFEST_FILENAME));
  if (manifestEnvelope.version !== MANIFEST_VERSION || !manifestEnvelope.catalog?.root) {
    throw new Error(
      `Unsupported archive version ${manifestEnvelope.version ?? "unknown"}. Stow vNext only opens v3 archives.`
    );
  }

  const root = await readEncryptedJson(rootCatalogPath(archivePath, manifestEnvelope), archiveKey);
  root.logs = capLogs(root.logs);
  return {
    manifestEnvelope,
    root
  };
}

async function saveRootCatalog(archivePath, manifestEnvelope, archiveKey, root) {
  const nextRoot = {
    ...root,
    version: MANIFEST_VERSION,
    logs: capLogs(root.logs),
    updatedAt: root.updatedAt || new Date().toISOString()
  };
  await writeEncryptedJson(rootCatalogPath(archivePath, manifestEnvelope), nextRoot, archiveKey);
}

async function readEntryCatalog(archivePath, archiveKey, entryId) {
  return readEncryptedJson(entryCatalogPath(archivePath, entryId), archiveKey);
}

async function writeEntryCatalog(archivePath, archiveKey, entry) {
  await writeEncryptedJson(entryCatalogPath(archivePath, entry.id), entry, archiveKey);
}

async function deleteEntryCatalog(archivePath, entryId) {
  await fs.rm(entryCatalogPath(archivePath, entryId), { force: true });
}

async function readObjectBucketCatalog(archivePath, archiveKey, prefix) {
  try {
    return await readEncryptedJson(objectBucketCatalogPath(archivePath, prefix), archiveKey);
  } catch (_error) {
    return {
      version: 1,
      prefix,
      objects: {}
    };
  }
}

async function writeObjectBucketCatalog(archivePath, archiveKey, prefix, bucket) {
  await writeEncryptedJson(objectBucketCatalogPath(archivePath, prefix), { version: 1, prefix, objects: bucket.objects }, archiveKey);
}

module.exports = {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  createArchiveCatalog,
  deleteEntryCatalog,
  entryCatalogPath,
  loadArchiveCatalog,
  objectBucketCatalogPath,
  readEntryCatalog,
  readObjectBucketCatalog,
  saveRootCatalog,
  writeEntryCatalog,
  writeObjectBucketCatalog
};
