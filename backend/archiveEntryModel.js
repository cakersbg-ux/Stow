const path = require("node:path");
const mime = require("mime-types");
const { normalizeEntrySummary } = require("./archiveQueryIndex");
const { normalizeArchiveDirectoryPath } = require("./archiveNamePolicy");

function entryFileName(entry, descriptor) {
  const baseName = entry.name.replace(path.extname(entry.name), "");
  const extension =
    descriptor.extension ||
    path.extname(entry.name) ||
    (mime.extension(descriptor.mime || "") ? `.${mime.extension(descriptor.mime)}` : "");
  return `${baseName}${extension}`;
}

function parentArchivePath(relativePath) {
  const parent = path.dirname(relativePath);
  return parent === "." ? "" : parent;
}

function folderName(relativePath) {
  const normalized = normalizeArchiveDirectoryPath(relativePath);
  return path.basename(normalized);
}

function parseFolderEntryId(entryId) {
  if (typeof entryId !== "string" || !entryId.startsWith("folder:")) {
    return null;
  }
  return entryId.slice("folder:".length);
}

function getLatestRevision(entry) {
  return entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId) ?? entry.revisions[0] ?? null;
}

function getEntryDisplaySize(entry) {
  const latestRevision = getLatestRevision(entry);
  return latestRevision?.optimizedArtifact?.size ?? latestRevision?.originalArtifact?.size ?? entry.size;
}

function getEntryPreviewKind(entry) {
  if (entry.fileKind === "image" || entry.fileKind === "video") {
    return entry.fileKind;
  }
  if (entry.mime === "image/jxl" || path.extname(entry.name).toLowerCase() === ".jxl") {
    return "image";
  }
  return null;
}

function buildLightweightEntry(entry) {
  const latestRevision = getLatestRevision(entry);
  return {
    id: entry.id,
    entryType: "file",
    name: entry.name,
    relativePath: entry.relativePath,
    fileKind: entry.fileKind,
    mime: entry.mime,
    size: getEntryDisplaySize(entry),
    sourceSize: entry.size,
    latestRevisionId: entry.latestRevisionId,
    overrideMode: latestRevision?.overrideMode ?? null,
    previewable: Boolean(getEntryPreviewKind(entry)),
    childCount: null
  };
}

function buildEntrySummary(entry) {
  const { entryType, childCount, ...summary } = buildLightweightEntry(entry);
  return summary;
}

function normalizePersistedSummaryEntries(summaryIndex) {
  if (!summaryIndex || typeof summaryIndex !== "object" || !summaryIndex.entries || typeof summaryIndex.entries !== "object") {
    return null;
  }
  const normalized = [];
  for (const value of Object.values(summaryIndex.entries)) {
    try {
      normalized.push(normalizeEntrySummary(value));
    } catch (_error) {
      return null;
    }
  }
  return normalized;
}

function buildEntryDetail(entry) {
  const latestRevision = getLatestRevision(entry);
  return {
    ...entry,
    size: getEntryDisplaySize(entry),
    sourceSize: entry.size,
    exportableVariants: {
      original: true,
      optimized: Boolean(latestRevision?.optimizedArtifact)
    }
  };
}

module.exports = {
  buildEntryDetail,
  buildEntrySummary,
  buildLightweightEntry,
  entryFileName,
  folderName,
  getEntryDisplaySize,
  getEntryPreviewKind,
  getLatestRevision,
  normalizePersistedSummaryEntries,
  parentArchivePath,
  parseFolderEntryId
};
