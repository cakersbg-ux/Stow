const path = require("node:path");
const { validate: isUuid } = require("uuid");

const MANIFEST_FILENAME = "manifest.json";
const ROOT_CATALOG_PATH = "catalog/root.enc";
const ENTRY_SUMMARY_INDEX_PATH = "catalog/entry-summary.enc";
const MUTATION_JOURNAL_PATH = "catalog/mutation-journal.enc";
const ENTRY_CATALOG_DIR = "catalog/entries";
const OBJECT_CATALOG_DIR = "catalog/objects";

const STORAGE_ID_PATTERN = /^[a-f0-9]{32}$/;
const OBJECT_BUCKET_PREFIX_PATTERN = /^[a-f0-9]{2}$/;

function normalizeArchiveRelativePath(relativePath) {
  if (typeof relativePath !== "string") {
    return null;
  }

  const trimmed = relativePath.trim();
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}

function resolveWithinArchiveRoot(archivePath, relativePath, label = "archive path") {
  const normalizedRelativePath = normalizeArchiveRelativePath(relativePath);
  if (!normalizedRelativePath) {
    throw new Error(`Unsafe ${label}: invalid relative path`);
  }

  const rootPath = path.resolve(archivePath);
  const resolvedPath = path.resolve(rootPath, ...normalizedRelativePath.split("/"));
  const relativeToRoot = path.relative(rootPath, resolvedPath);
  if (
    relativeToRoot === "" ||
    (relativeToRoot && !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot))
  ) {
    return resolvedPath;
  }

  throw new Error(`Unsafe ${label}: path escapes archive root`);
}

function assertValidEntryId(entryId) {
  if (!isUuid(entryId)) {
    throw new Error("Unsafe archive entry metadata: entry ids must be UUIDs");
  }
  return entryId;
}

function assertValidObjectBucketPrefix(prefix) {
  if (typeof prefix !== "string" || !OBJECT_BUCKET_PREFIX_PATTERN.test(prefix)) {
    throw new Error("Unsafe archive object metadata: bucket prefixes must be two hex characters");
  }
  return prefix.toLowerCase();
}

function assertValidStorageId(storageId) {
  if (typeof storageId !== "string" || !STORAGE_ID_PATTERN.test(storageId)) {
    throw new Error("Unsafe legacy object metadata: storageId must be 32 hex characters");
  }
  return storageId.toLowerCase();
}

function validateManifestEnvelope(manifestEnvelope, manifestVersion) {
  if (manifestEnvelope?.version !== manifestVersion) {
    throw new Error(
      `Unsupported archive version ${manifestEnvelope?.version ?? "unknown"}. Stow vNext only opens v${manifestVersion} archives.`
    );
  }

  const catalog = manifestEnvelope?.catalog;
  if (!catalog || typeof catalog.root !== "string") {
    throw new Error("Unsafe archive manifest: missing catalog.root");
  }

  const normalizedRoot = normalizeArchiveRelativePath(catalog.root);
  if (normalizedRoot !== ROOT_CATALOG_PATH) {
    throw new Error(`Unsafe archive manifest: catalog.root must be ${ROOT_CATALOG_PATH}`);
  }

  if (catalog.entriesDir !== undefined) {
    const normalizedEntriesDir = normalizeArchiveRelativePath(catalog.entriesDir);
    if (normalizedEntriesDir !== ENTRY_CATALOG_DIR) {
      throw new Error(`Unsafe archive manifest: catalog.entriesDir must be ${ENTRY_CATALOG_DIR}`);
    }
  }

  if (catalog.entrySummaryIndex !== undefined) {
    const normalizedEntrySummaryIndex = normalizeArchiveRelativePath(catalog.entrySummaryIndex);
    if (normalizedEntrySummaryIndex !== ENTRY_SUMMARY_INDEX_PATH) {
      throw new Error(`Unsafe archive manifest: catalog.entrySummaryIndex must be ${ENTRY_SUMMARY_INDEX_PATH}`);
    }
  }

  if (catalog.mutationJournal !== undefined) {
    const normalizedMutationJournal = normalizeArchiveRelativePath(catalog.mutationJournal);
    if (normalizedMutationJournal !== MUTATION_JOURNAL_PATH) {
      throw new Error(`Unsafe archive manifest: catalog.mutationJournal must be ${MUTATION_JOURNAL_PATH}`);
    }
  }

  if (catalog.objectBucketsDir !== undefined) {
    const normalizedObjectBucketsDir = normalizeArchiveRelativePath(catalog.objectBucketsDir);
    if (normalizedObjectBucketsDir !== OBJECT_CATALOG_DIR) {
      throw new Error(`Unsafe archive manifest: catalog.objectBucketsDir must be ${OBJECT_CATALOG_DIR}`);
    }
  }

  return {
    ...manifestEnvelope,
    catalog: {
      ...catalog,
      root: ROOT_CATALOG_PATH,
      entriesDir: ENTRY_CATALOG_DIR,
      entrySummaryIndex: ENTRY_SUMMARY_INDEX_PATH,
      mutationJournal: MUTATION_JOURNAL_PATH,
      objectBucketsDir: OBJECT_CATALOG_DIR
    }
  };
}

function validateRootCatalog(root) {
  if (!Array.isArray(root?.entryOrder)) {
    throw new Error("Unsafe archive root catalog: entryOrder must be an array");
  }

  for (const entryId of root.entryOrder) {
    assertValidEntryId(entryId);
  }

  return root;
}

module.exports = {
  ENTRY_CATALOG_DIR,
  ENTRY_SUMMARY_INDEX_PATH,
  MANIFEST_FILENAME,
  MUTATION_JOURNAL_PATH,
  OBJECT_CATALOG_DIR,
  ROOT_CATALOG_PATH,
  assertValidEntryId,
  assertValidObjectBucketPrefix,
  assertValidStorageId,
  normalizeArchiveRelativePath,
  resolveWithinArchiveRoot,
  validateManifestEnvelope,
  validateRootCatalog
};
