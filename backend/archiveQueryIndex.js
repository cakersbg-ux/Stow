const path = require("node:path");

const DEFAULT_SORT_COLUMN = "name";
const DEFAULT_SORT_DIRECTION = "asc";
const MAX_LISTING_CACHE_ENTRIES = 128;

function normalizeRelativePath(relativePath) {
  if (typeof relativePath !== "string") {
    throw new Error("Archive path is required");
  }

  const normalized = path.normalize(relativePath);
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    throw new Error("Archive path is invalid");
  }

  const segments = normalized.split(path.sep);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Archive path is invalid");
  }

  return normalized;
}

function normalizeDirectoryPath(directoryPath, { allowRoot = false } = {}) {
  if (directoryPath === "" || directoryPath === null || typeof directoryPath === "undefined") {
    if (allowRoot) {
      return "";
    }
    throw new Error("Folder path is required");
  }

  const normalized = normalizeRelativePath(directoryPath);
  return normalized === "." ? "" : normalized;
}

function parentPath(relativePath) {
  const parent = path.dirname(relativePath);
  return parent === "." ? "" : parent;
}

function ancestorFolderPaths(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const ancestors = [];
  let current = path.dirname(normalized);

  while (current && current !== ".") {
    ancestors.unshift(current);
    current = path.dirname(current);
  }

  return ancestors;
}

function normalizeEntrySummary(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("Entry summary is required");
  }

  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
  if (!id) {
    throw new Error("Entry id is required");
  }

  const relativePath = normalizeRelativePath(entry.relativePath);
  const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : path.basename(relativePath);

  return {
    ...entry,
    id,
    name,
    relativePath,
    fileKind: typeof entry.fileKind === "string" && entry.fileKind.trim() ? entry.fileKind : "file"
  };
}

function normalizeListSortColumn(sortColumn) {
  return sortColumn === "type" || sortColumn === "size" ? sortColumn : DEFAULT_SORT_COLUMN;
}

function normalizeListSortDirection(sortDirection) {
  return sortDirection === "desc" ? "desc" : DEFAULT_SORT_DIRECTION;
}

function compareListEntries(left, right, sortColumn, sortDirection) {
  if (left.entryType !== right.entryType) {
    return left.entryType === "folder" ? -1 : 1;
  }

  const direction = sortDirection === "desc" ? -1 : 1;
  switch (sortColumn) {
    case "type":
      return left.fileKind.localeCompare(right.fileKind) * direction;
    case "size":
      return ((left.size ?? -1) - (right.size ?? -1)) * direction;
    case "name":
    default:
      return left.name.localeCompare(right.name) * direction;
  }
}

function createDirectoryBucket() {
  return {
    folders: new Set(),
    files: new Set()
  };
}

function buildListingCacheKey(directoryPath, sortColumn, sortDirection) {
  return `${directoryPath}\u0000${sortColumn}\u0000${sortDirection}`;
}

function buildFolderListItem(relativePath, childCount) {
  return {
    id: `folder:${relativePath}`,
    entryType: "folder",
    name: path.basename(relativePath),
    relativePath,
    fileKind: "folder",
    mime: null,
    size: null,
    sourceSize: null,
    latestRevisionId: null,
    overrideMode: null,
    previewable: false,
    childCount
  };
}

function buildEntryListItem(entry) {
  return {
    ...entry,
    entryType: "file",
    childCount: null
  };
}

class ArchiveQueryIndex {
  constructor({ folders = [], entries = [] } = {}) {
    this.explicitFolders = new Set();
    this.entries = new Map();
    this.entryPathIndex = new Map();
    this.directoryBuckets = new Map();
    this.folderDescendantCounts = new Map();
    this.allFolders = new Set();
    this.listingCache = new Map();
    this.replace({ folders, entries });
  }

  static fromSnapshot(snapshot = {}) {
    return new ArchiveQueryIndex(snapshot);
  }

  clear() {
    this.explicitFolders.clear();
    this.entries.clear();
    this.entryPathIndex.clear();
    this.directoryBuckets.clear();
    this.folderDescendantCounts.clear();
    this.allFolders.clear();
    this.listingCache.clear();
  }

  replace({ folders = [], entries = [] } = {}) {
    this.clear();

    for (const folderPath of Array.isArray(folders) ? folders : []) {
      this.explicitFolders.add(normalizeDirectoryPath(folderPath));
    }

    for (const entry of Array.isArray(entries) ? entries : []) {
      const normalized = normalizeEntrySummary(entry);
      this.entries.set(normalized.id, normalized);
    }

    this.rebuildDerivedIndexes();
    return this;
  }

  rebuildDerivedIndexes() {
    const nextBuckets = new Map();
    const nextFolderCounts = new Map();
    const nextAllFolders = new Set();
    const nextEntryPathIndex = new Map();
    const seenPaths = new Map();

    const ensureBucket = (directoryPath) => {
      const normalizedDirectory = normalizeDirectoryPath(directoryPath, { allowRoot: true });
      let bucket = nextBuckets.get(normalizedDirectory);
      if (!bucket) {
        bucket = createDirectoryBucket();
        nextBuckets.set(normalizedDirectory, bucket);
      }
      return bucket;
    };

    const registerFolder = (folderPath) => {
      const normalized = normalizeDirectoryPath(folderPath);
      if (nextAllFolders.has(normalized)) {
        return normalized;
      }

      nextAllFolders.add(normalized);
      ensureBucket(normalized);
      const parent = parentPath(normalized);
      ensureBucket(parent).folders.add(normalized);
      return normalized;
    };

    ensureBucket("");

    for (const folderPath of this.explicitFolders) {
      registerFolder(folderPath);
    }

    for (const entry of this.entries.values()) {
      for (const ancestorPath of ancestorFolderPaths(entry.relativePath)) {
        registerFolder(ancestorPath);
      }
    }

    for (const folderPath of nextAllFolders) {
      ensureBucket(folderPath);
    }

    for (const entry of this.entries.values()) {
      if (seenPaths.has(entry.relativePath) && seenPaths.get(entry.relativePath) !== entry.id) {
        throw new Error(`Duplicate entry path: ${entry.relativePath}`);
      }
      seenPaths.set(entry.relativePath, entry.id);

      nextEntryPathIndex.set(entry.relativePath, entry.id);
      ensureBucket(parentPath(entry.relativePath)).files.add(entry.id);

      for (const ancestorPath of ancestorFolderPaths(entry.relativePath)) {
        if (!nextAllFolders.has(ancestorPath)) {
          continue;
        }
        nextFolderCounts.set(ancestorPath, (nextFolderCounts.get(ancestorPath) || 0) + 1);
      }
    }

    this.directoryBuckets = nextBuckets;
    this.folderDescendantCounts = nextFolderCounts;
    this.allFolders = nextAllFolders;
    this.entryPathIndex = nextEntryPathIndex;
    this.listingCache.clear();
  }

  upsertFolder(folderPath) {
    const normalized = normalizeDirectoryPath(folderPath);
    this.explicitFolders.add(normalized);
    this.rebuildDerivedIndexes();
    return normalized;
  }

  removeFolder(folderPath) {
    const normalized = normalizeDirectoryPath(folderPath);
    this.explicitFolders.delete(normalized);
    this.rebuildDerivedIndexes();
  }

  upsertEntry(entry) {
    const normalized = normalizeEntrySummary(entry);
    this.entries.set(normalized.id, normalized);
    this.rebuildDerivedIndexes();
    return normalized.id;
  }

  removeEntry(entryId) {
    if (typeof entryId !== "string" || !entryId.trim()) {
      throw new Error("Entry id is required");
    }

    this.entries.delete(entryId.trim());
    this.rebuildDerivedIndexes();
  }

  getEntryById(entryId) {
    if (typeof entryId !== "string" || !entryId.trim()) {
      return null;
    }
    return this.entries.get(entryId.trim()) || null;
  }

  findEntryIdByRelativePath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    return this.entryPathIndex.get(normalized) || null;
  }

  hasFolder(folderPath) {
    const normalized = normalizeDirectoryPath(folderPath, { allowRoot: true });
    if (!normalized) {
      return true;
    }
    return this.allFolders.has(normalized);
  }

  getDirectoryBucket(directoryPath) {
    const normalized = normalizeDirectoryPath(directoryPath, { allowRoot: true });
    const bucket = this.directoryBuckets.get(normalized);
    if (!bucket) {
      return null;
    }

    return {
      folders: new Set(bucket.folders),
      files: new Set(bucket.files)
    };
  }

  listEntries({ directory = "", offset = 0, limit = 100, sortColumn = DEFAULT_SORT_COLUMN, sortDirection = DEFAULT_SORT_DIRECTION } = {}) {
    const normalizedDirectory = normalizeDirectoryPath(directory, { allowRoot: true });
    const normalizedSortColumn = normalizeListSortColumn(sortColumn);
    const normalizedSortDirection = normalizeListSortDirection(sortDirection);
    const start = Math.max(0, Math.trunc(offset));
    const length = Math.max(0, Math.trunc(limit));
    const cacheKey = buildListingCacheKey(normalizedDirectory, normalizedSortColumn, normalizedSortDirection);
    let cachedListing = this.listingCache.get(cacheKey);

    if (!cachedListing) {
      const bucket = this.directoryBuckets.get(normalizedDirectory) || createDirectoryBucket();

      const folderItems = [...bucket.folders]
        .sort((left, right) => left.localeCompare(right))
        .map((relativePath) => buildFolderListItem(relativePath, this.folderDescendantCounts.get(relativePath) || 0));
      const fileItems = [...bucket.files]
        .map((entryId) => this.entries.get(entryId))
        .filter(Boolean)
        .map((entry) => buildEntryListItem(entry));

      folderItems.sort((left, right) => compareListEntries(left, right, normalizedSortColumn, normalizedSortDirection));
      fileItems.sort((left, right) => compareListEntries(left, right, normalizedSortColumn, normalizedSortDirection));

      cachedListing = {
        total: folderItems.length + fileItems.length,
        items: [...folderItems, ...fileItems]
      };
      this.listingCache.set(cacheKey, cachedListing);
      if (this.listingCache.size > MAX_LISTING_CACHE_ENTRIES) {
        const oldestKey = this.listingCache.keys().next().value;
        if (typeof oldestKey !== "undefined") {
          this.listingCache.delete(oldestKey);
        }
      }
    } else {
      this.listingCache.delete(cacheKey);
      this.listingCache.set(cacheKey, cachedListing);
    }

    return {
      total: cachedListing.total,
      items: cachedListing.items.slice(start, start + length)
    };
  }
}

module.exports = {
  ArchiveQueryIndex,
  compareListEntries,
  normalizeDirectoryPath,
  normalizeEntrySummary,
  normalizeRelativePath
};
