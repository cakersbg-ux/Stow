const {
  deleteEntryCatalog,
  deleteMutationJournal,
  loadArchiveCatalog,
  readEntryCatalog,
  readEntrySummaryIndex,
  readMutationJournal,
  saveRootCatalog,
  writeEntryCatalog,
  writeEntrySummaryIndex,
  writeMutationJournal
} = require("./catalogStore");
const path = require("node:path");
const fs = require("node:fs/promises");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (_error) {
  DatabaseSync = null;
}

class MetadataStore {
  async begin() {
    throw new Error("MetadataStore.begin() must be implemented");
  }

  async commit() {
    throw new Error("MetadataStore.commit() must be implemented");
  }

  async rollback() {
    throw new Error("MetadataStore.rollback() must be implemented");
  }

  async getEntryById() {
    throw new Error("MetadataStore.getEntryById() must be implemented");
  }

  async getEntryByPath() {
    throw new Error("MetadataStore.getEntryByPath() must be implemented");
  }

  async listEntries() {
    throw new Error("MetadataStore.listEntries() must be implemented");
  }

  async upsertEntry() {
    throw new Error("MetadataStore.upsertEntry() must be implemented");
  }

  async deleteEntry() {
    throw new Error("MetadataStore.deleteEntry() must be implemented");
  }

  async upsertFolder() {
    throw new Error("MetadataStore.upsertFolder() must be implemented");
  }

  async deleteFolder() {
    throw new Error("MetadataStore.deleteFolder() must be implemented");
  }

  async pruneImplicitFolders() {
    throw new Error("MetadataStore.pruneImplicitFolders() must be implemented");
  }

  async writeSummaryIndex() {
    throw new Error("MetadataStore.writeSummaryIndex() must be implemented");
  }

  async readSummaryIndex() {
    throw new Error("MetadataStore.readSummaryIndex() must be implemented");
  }

  async writeMutationJournal() {
    throw new Error("MetadataStore.writeMutationJournal() must be implemented");
  }

  async readMutationJournal() {
    throw new Error("MetadataStore.readMutationJournal() must be implemented");
  }
}

class JsonMetadataStore extends MetadataStore {
  constructor(session) {
    super();
    this.session = session;
    this.activeTransaction = null;
  }

  static async loadArchive(archivePath, archiveKey) {
    return loadArchiveCatalog(archivePath, archiveKey);
  }

  async begin({ rootSnapshot } = {}) {
    if (this.activeTransaction) {
      this.activeTransaction.depth += 1;
      return this.activeTransaction;
    }
    const snapshot = rootSnapshot
      ? JSON.parse(JSON.stringify(rootSnapshot))
      : JSON.parse(JSON.stringify(this.session.root));
    this.activeTransaction = {
      rootSnapshot: snapshot,
      depth: 1
    };
    return this.activeTransaction;
  }

  async commit({ root, updatedAt = null } = {}) {
    const nextRoot = {
      ...(root || this.session.root)
    };
    if (updatedAt) {
      nextRoot.updatedAt = updatedAt;
    }
    await saveRootCatalog(
      this.session.path,
      this.session.manifestEnvelope,
      this.session.archiveKey,
      nextRoot
    );
    return nextRoot;
  }

  async rollback(transaction = null) {
    if (!this.activeTransaction) {
      return null;
    }
    if (transaction && transaction !== this.activeTransaction) {
      return null;
    }
    this.activeTransaction.depth = Math.max(0, (this.activeTransaction.depth || 1) - 1);
    if (this.activeTransaction.depth === 0) {
      this.activeTransaction = null;
    }
    return null;
  }

  async getEntryById(entryId) {
    return readEntryCatalog(this.session.path, this.session.archiveKey, entryId);
  }

  async getEntryByPath(relativePath) {
    const entryId = this.session.queryIndex.findEntryIdByRelativePath(relativePath);
    return entryId ? this.getEntryById(entryId) : null;
  }

  async listEntries(options = {}) {
    return this.session.queryIndex.listEntries(options);
  }

  async upsertEntry(entry) {
    await writeEntryCatalog(this.session.path, this.session.archiveKey, entry);
  }

  async deleteEntry(entryId) {
    await deleteEntryCatalog(this.session.path, entryId);
  }

  async upsertFolder(folderPath) {
    if (!this.session.folderSet.has(folderPath)) {
      this.session.root.folders.push(folderPath);
      this.session.root.folders.sort((left, right) => left.localeCompare(right));
      this.session.folderSet.add(folderPath);
      this.session.queryIndex.upsertFolder(folderPath);
    }
  }

  async deleteFolder(folderPath) {
    this.session.root.folders = this.session.root.folders.filter((candidate) => candidate !== folderPath);
    this.session.folderSet.delete(folderPath);
    this.session.queryIndex.removeFolder(folderPath);
  }

  async pruneImplicitFolders({ startPath, hasContents, implicitFolders }) {
    let current = startPath;
    while (current) {
      if (!implicitFolders.has(current)) {
        return;
      }
      if (await hasContents(current)) {
        return;
      }
      await this.deleteFolder(current);
      current = current.includes("/") || current.includes("\\")
        ? current.split(/[\\/]+/).slice(0, -1).join("/")
        : "";
    }
  }

  async writeSummaryIndex(summaryIndex) {
    await writeEntrySummaryIndex(this.session.path, this.session.archiveKey, summaryIndex);
  }

  async readSummaryIndex() {
    return readEntrySummaryIndex(this.session.path, this.session.archiveKey);
  }

  async writeMutationJournal(mutationJournal) {
    await writeMutationJournal(this.session.path, this.session.archiveKey, mutationJournal);
  }

  async readMutationJournal() {
    return readMutationJournal(this.session.path, this.session.archiveKey);
  }

  async clearMutationJournal() {
    await deleteMutationJournal(this.session.path);
  }
}

class SqliteMetadataStore extends MetadataStore {
  constructor(session) {
    super();
    this.session = session;
    this.activeTransaction = null;
    this.db = null;
  }

  static async loadArchive(archivePath, archiveKey) {
    return loadArchiveCatalog(archivePath, archiveKey);
  }

  async ensureDb() {
    if (!DatabaseSync) {
      throw new Error("SQLite metadata adapter requires node:sqlite support");
    }
    if (this.db) {
      return this.db;
    }
    const catalogDir = path.join(this.session.path, "catalog");
    await fs.mkdir(catalogDir, { recursive: true });
    const dbPath = path.join(catalogDir, "metadata.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    return this.db;
  }

  async begin({ rootSnapshot } = {}) {
    if (this.activeTransaction) {
      this.activeTransaction.depth += 1;
      return this.activeTransaction;
    }
    const snapshot = rootSnapshot
      ? JSON.parse(JSON.stringify(rootSnapshot))
      : JSON.parse(JSON.stringify(this.session.root));
    this.activeTransaction = {
      rootSnapshot: snapshot,
      depth: 1
    };
    return this.activeTransaction;
  }

  async commit({ root, updatedAt = null } = {}) {
    const nextRoot = {
      ...(root || this.session.root)
    };
    if (updatedAt) {
      nextRoot.updatedAt = updatedAt;
    }
    await saveRootCatalog(
      this.session.path,
      this.session.manifestEnvelope,
      this.session.archiveKey,
      nextRoot
    );
    return nextRoot;
  }

  async rollback(transaction = null) {
    if (!this.activeTransaction) {
      return null;
    }
    if (transaction && transaction !== this.activeTransaction) {
      return null;
    }
    this.activeTransaction.depth = Math.max(0, (this.activeTransaction.depth || 1) - 1);
    if (this.activeTransaction.depth === 0) {
      this.activeTransaction = null;
    }
    return null;
  }

  async readEntryByIdFromSqlite(entryId) {
    const db = await this.ensureDb();
    const row = db
      .prepare("SELECT payload FROM entries WHERE id = ?")
      .get(entryId);
    if (!row?.payload) {
      return null;
    }
    try {
      return JSON.parse(row.payload);
    } catch (_error) {
      return null;
    }
  }

  async readEntryByPathFromSqlite(relativePath) {
    const db = await this.ensureDb();
    const row = db
      .prepare("SELECT payload FROM entries WHERE relative_path = ?")
      .get(relativePath);
    if (!row?.payload) {
      return null;
    }
    try {
      return JSON.parse(row.payload);
    } catch (_error) {
      return null;
    }
  }

  async getEntryById(entryId) {
    const cached = await this.readEntryByIdFromSqlite(entryId);
    if (cached) {
      return cached;
    }
    const entry = await readEntryCatalog(this.session.path, this.session.archiveKey, entryId);
    await this.upsertEntry(entry);
    return entry;
  }

  async getEntryByPath(relativePath) {
    const cached = await this.readEntryByPathFromSqlite(relativePath);
    if (cached) {
      return cached;
    }
    const entryId = this.session.queryIndex.findEntryIdByRelativePath(relativePath);
    if (!entryId) {
      return null;
    }
    return this.getEntryById(entryId);
  }

  async listEntries(options = {}) {
    return this.session.queryIndex.listEntries(options);
  }

  async upsertEntry(entry) {
    await writeEntryCatalog(this.session.path, this.session.archiveKey, entry);
    const db = await this.ensureDb();
    db.prepare(`
      INSERT INTO entries (id, relative_path, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        relative_path = excluded.relative_path,
        payload = excluded.payload
    `).run(entry.id, entry.relativePath, JSON.stringify(entry));
  }

  async deleteEntry(entryId) {
    await deleteEntryCatalog(this.session.path, entryId);
    const db = await this.ensureDb();
    db.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
  }

  async upsertFolder(folderPath) {
    if (!this.session.folderSet.has(folderPath)) {
      this.session.root.folders.push(folderPath);
      this.session.root.folders.sort((left, right) => left.localeCompare(right));
      this.session.folderSet.add(folderPath);
      this.session.queryIndex.upsertFolder(folderPath);
    }
  }

  async deleteFolder(folderPath) {
    this.session.root.folders = this.session.root.folders.filter((candidate) => candidate !== folderPath);
    this.session.folderSet.delete(folderPath);
    this.session.queryIndex.removeFolder(folderPath);
  }

  async pruneImplicitFolders({ startPath, hasContents, implicitFolders }) {
    let current = startPath;
    while (current) {
      if (!implicitFolders.has(current)) {
        return;
      }
      if (await hasContents(current)) {
        return;
      }
      await this.deleteFolder(current);
      current = current.includes("/") || current.includes("\\")
        ? current.split(/[\\/]+/).slice(0, -1).join("/")
        : "";
    }
  }

  async writeSummaryIndex(summaryIndex) {
    await writeEntrySummaryIndex(this.session.path, this.session.archiveKey, summaryIndex);
    const db = await this.ensureDb();
    db.prepare(`
      INSERT INTO kv (key, value)
      VALUES ('entry_summary_index', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(summaryIndex));
  }

  async readSummaryIndex() {
    const db = await this.ensureDb();
    const row = db.prepare("SELECT value FROM kv WHERE key = 'entry_summary_index'").get();
    if (row?.value) {
      try {
        return JSON.parse(row.value);
      } catch (_error) {
        return readEntrySummaryIndex(this.session.path, this.session.archiveKey);
      }
    }
    return readEntrySummaryIndex(this.session.path, this.session.archiveKey);
  }

  async writeMutationJournal(mutationJournal) {
    await writeMutationJournal(this.session.path, this.session.archiveKey, mutationJournal);
    const db = await this.ensureDb();
    db.prepare(`
      INSERT INTO kv (key, value)
      VALUES ('mutation_journal', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(mutationJournal));
  }

  async readMutationJournal() {
    const db = await this.ensureDb();
    const row = db.prepare("SELECT value FROM kv WHERE key = 'mutation_journal'").get();
    if (row?.value) {
      try {
        return JSON.parse(row.value);
      } catch (_error) {
        return readMutationJournal(this.session.path, this.session.archiveKey);
      }
    }
    return readMutationJournal(this.session.path, this.session.archiveKey);
  }

  async clearMutationJournal() {
    await deleteMutationJournal(this.session.path);
    const db = await this.ensureDb();
    db.prepare("DELETE FROM kv WHERE key = 'mutation_journal'").run();
  }
}

function metadataStoreKindFromEnv() {
  const raw = process.env.STOW_METADATA_STORE;
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return normalized === "sqlite" ? "sqlite" : "json";
}

function createMetadataStore(session, options = {}) {
  const kind = options.kind || metadataStoreKindFromEnv();
  if (kind === "sqlite") {
    return new SqliteMetadataStore(session);
  }
  return new JsonMetadataStore(session);
}

module.exports = {
  createMetadataStore,
  JsonMetadataStore,
  MetadataStore,
  SqliteMetadataStore
};
