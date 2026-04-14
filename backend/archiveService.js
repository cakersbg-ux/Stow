const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { v4: uuid } = require("uuid");
const { atomicWriteJson } = require("./atomicFile");
const { createArchiveEncryption, unlockArchiveKey } = require("./crypto");
const {
  DEFAULT_SETTINGS,
  saveRecentArchives,
  normalizeSettings
} = require("./appState");
const {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  createArchiveCatalog,
  deleteEntryCatalog,
  loadArchiveCatalog,
  readMutationJournal,
  saveRootCatalog,
  writeEntryCatalog,
  deleteMutationJournal
} = require("./catalogStore");
const { ArchiveQueryIndex } = require("./archiveQueryIndex");
const {
  buildEntryDetail,
  buildEntrySummary,
  entryFileName,
  folderName,
  getEntryPreviewKind,
  normalizePersistedSummaryEntries,
  parentArchivePath,
  parseFolderEntryId
} = require("./archiveEntryModel");
const { analyzePath, classifyPath, generatePreviewFile } = require("./mediaTools");
const { ObjectStore } = require("./objectStore");
const {
  createMetadataStore,
  JsonMetadataStore,
  SqliteMetadataStore
} = require("./metadataStore");
const {
  collectInputFiles,
  ensureDir,
  exists,
  isDirectory,
  spawnOpenFile,
  withTempDir
} = require("./archiveFs");
const {
  computeSessionExpiry,
  normalizeArchivePreferences,
  normalizeIdleMinutes,
  normalizeSessionPolicy,
  resolveEffectiveSessionPolicy
} = require("./policies");
const { PreviewCache } = require("./previewCache");
const { createArchiveMutationTransaction } = require("./archiveMutationTransaction");
const {
  normalizeArchiveDirectoryPath,
  normalizeArchiveRelativePath,
  validateArchiveDirectoryNames,
  validateArchiveName,
  validateEntryRename
} = require("./archiveNamePolicy");

const OPEN_TEMP_DIRNAME = "open-files";
const PREVIEW_KINDS = ["thumbnail", "preview"];
const MAX_RECENT_ARCHIVES = 20;
const ENTRY_SUMMARY_INDEX_VERSION = 1;
const MUTATION_JOURNAL_VERSION = 1;

async function writeJson(filePath, value) {
  await atomicWriteJson(filePath, value);
}

function cloneJson(value) {
  if (value === null || typeof value === "undefined") {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function hashMutationJournalRoot(root) {
  return createHash("sha256").update(JSON.stringify(cloneJson(root))).digest("hex");
}

class ArchiveService {
  constructor(state, emitters) {
    this.state = state;
    this.emitShellState = emitters.emitShellState;
    this.emitProgress = emitters.emitProgress;
    this.emitEntriesInvalidated = emitters.emitEntriesInvalidated;
    this.autoLockTimer = null;
    this.activeSessionOperations = 0;
    this.activeMutationContext = null;
    this.previewCache = new PreviewCache({
      baseDir: this.state.previewCachePath
    });
  }

  async initialize() {
    await ensureDir(this.state.runtimeTempPath);
    await this.previewCache.initialize();
    await this.cleanupOpenTempArtifacts();
  }

  previewKey(entryId, revisionId, kind) {
    const session = this.requireArchiveSession();
    return {
      archiveId: session.root.archiveId,
      entryId,
      revisionId,
      kind
    };
  }

  async cacheRevisionPreviews(entryId, revisionId, fileKind, sourcePath) {
    if (!sourcePath || !["image", "video"].includes(fileKind)) {
      return;
    }

    try {
      for (const kind of PREVIEW_KINDS) {
        const key = this.previewKey(entryId, revisionId, kind);
        const outputDir = this.previewCache.previewDir(key);
        await ensureDir(outputDir);
        const preview = await generatePreviewFile(sourcePath, fileKind, kind, outputDir, this.state.capabilities);
        if (!preview) {
          continue;
        }

        await this.previewCache.writeDescriptor(key, {
          path: preview.path,
          mime: preview.mime,
          revisionId,
          kind
        });
      }
    } catch (error) {
      this.pushLog(
        `failed to cache previews for revision ${revisionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async deleteEntryPreviewArtifacts(entry) {
    for (const revision of entry?.revisions || []) {
      for (const kind of PREVIEW_KINDS) {
        await this.previewCache.deletePreviewDir(this.previewKey(entry.id, revision.id, kind));
      }
    }
  }

  async deleteRevisionPreviewArtifacts(entryId, revisionId) {
    for (const kind of PREVIEW_KINDS) {
      await this.previewCache.deletePreviewDir(this.previewKey(entryId, revisionId, kind));
    }
  }

  markDirectoryIndexDirty() {
    const session = this.state.archiveSession;
    if (session) {
      session.directoryIndexReady = false;
      session.entryPathIndexReady = false;
    }
  }

  refreshQueryIndexFolders() {
    const session = this.requireArchiveSession();
    session.queryIndex.replace({
      folders: session.root.folders,
      entries: [...session.queryIndex.entries.values()].map((summary) => ({ ...summary }))
    });
    session.folderSet = new Set(session.root.folders);
    session.directoryIndexReady = true;
  }

  buildSummaryIndexDocument() {
    const session = this.requireArchiveSession();
    const entries = {};
    for (const summary of session.queryIndex.entries.values()) {
      entries[summary.id] = {
        ...summary
      };
    }

    return {
      version: ENTRY_SUMMARY_INDEX_VERSION,
      rootUpdatedAt: session.root.updatedAt || null,
      entries
    };
  }

  async persistEntrySummaryIndex() {
    const session = this.requireArchiveSession();
    await session.metadataStore.writeSummaryIndex(this.buildSummaryIndexDocument());
  }

  async loadPersistedEntrySummaries() {
    const session = this.requireArchiveSession();
    try {
      const summaryIndex = await session.metadataStore.readSummaryIndex();
      if (summaryIndex?.version !== ENTRY_SUMMARY_INDEX_VERSION) {
        return null;
      }
      const entries = normalizePersistedSummaryEntries(summaryIndex);
      if (!entries) {
        return null;
      }
      return {
        rootUpdatedAt: typeof summaryIndex.rootUpdatedAt === "string" ? summaryIndex.rootUpdatedAt : null,
        entries
      };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return null;
      }
      return null;
    }
  }

  hasUsablePersistedEntrySummaries(persisted) {
    const session = this.requireArchiveSession();
    if (!persisted || !Array.isArray(persisted.entries)) {
      return false;
    }
    if (!persisted.rootUpdatedAt || persisted.rootUpdatedAt !== session.root.updatedAt) {
      return false;
    }

    const entryIds = new Set(session.root.entryOrder);
    if (persisted.entries.length !== entryIds.size) {
      return false;
    }

    for (const summary of persisted.entries) {
      if (!entryIds.has(summary.id)) {
        return false;
      }
    }

    return true;
  }

  async initializeQueryIndexForSession() {
    const session = this.requireArchiveSession();
    const persisted = await this.loadPersistedEntrySummaries();
    if (this.hasUsablePersistedEntrySummaries(persisted)) {
      session.queryIndex.replace({
        folders: session.root.folders,
        entries: persisted.entries
      });
      session.folderSet = new Set(session.root.folders);
      session.directoryIndexReady = true;
      session.entryPathIndexReady = true;
      return;
    }

    await this.rebuildDirectoryIndex();
    await this.persistEntrySummaryIndex().catch(() => {});
  }

  async rebuildDirectoryIndex() {
    const session = this.requireArchiveSession();
    const entrySummaries = [];
    for (const entryId of session.root.entryOrder) {
      const entry = await this.loadEntry(entryId);
      if (!entry?.relativePath) {
        continue;
      }
      entrySummaries.push(buildEntrySummary(entry));
    }

    session.queryIndex.replace({
      folders: session.root.folders,
      entries: entrySummaries
    });
    session.folderSet = new Set(session.root.folders);
    session.directoryIndexReady = true;
    session.entryPathIndexReady = true;
  }

  async ensureDirectoryIndex() {
    const session = this.requireArchiveSession();
    if (session.directoryIndexReady) {
      return;
    }

    await this.rebuildDirectoryIndex();
  }

  async folderHasContents(folderPath) {
    const session = this.requireArchiveSession();
    const normalized = normalizeArchiveDirectoryPath(folderPath, { allowRoot: true });
    const bucket = session.queryIndex.getDirectoryBucket(normalized);
    return Boolean(bucket && (bucket.folders.size > 0 || bucket.files.size > 0));
  }

  removeFolderPath(folderPath) {
    const session = this.requireArchiveSession();
    const normalized = normalizeArchiveDirectoryPath(folderPath);
    session.root.folders = session.root.folders.filter((candidate) => candidate !== normalized);
    session.folderSet.delete(normalized);
    session.implicitFolders.delete(normalized);
    session.queryIndex.removeFolder(normalized);
    this.markDirectoryIndexDirty();
  }

  async pruneEmptyImplicitFoldersFrom(startPath) {
    const session = this.requireArchiveSession();
    let current = normalizeArchiveDirectoryPath(startPath, { allowRoot: true });

    while (current) {
      if (!session.implicitFolders.has(current)) {
        return;
      }
      if (await this.folderHasContents(current)) {
        return;
      }

      this.removeFolderPath(current);
      current = parentArchivePath(current);
    }
  }

  restoreSessionRoot(rootSnapshot) {
    const session = this.requireArchiveSession();
    const previousImplicitFolders = session.implicitFolders || new Set();
    session.root = {
      ...cloneJson(rootSnapshot),
      folders: [...new Set(Array.isArray(rootSnapshot?.folders) ? rootSnapshot.folders : [])].sort((left, right) =>
        left.localeCompare(right)
      ),
      preferences: normalizeArchivePreferences(rootSnapshot?.preferences)
    };
    session.folderSet = new Set(session.root.folders);
    session.implicitFolders = new Set([...previousImplicitFolders].filter((folderPath) => session.folderSet.has(folderPath)));
    this.markDirectoryIndexDirty();
  }

  resetEntryCaches() {
    const session = this.requireArchiveSession();
    session.entryCache.clear();
    session.entryPathIndex.clear();
    session.entryPathIndexReady = false;
  }

  buildMutationJournalDocument(context) {
    const trackedEntryCatalogs = {};
    for (const [entryId, previousEntry] of context.trackedEntryCatalogs.entries()) {
      trackedEntryCatalogs[entryId] = previousEntry ? cloneJson(previousEntry) : null;
    }

    return {
      version: MUTATION_JOURNAL_VERSION,
      type: "metadata-mutation",
      state: "pending",
      startedAt: context.startedAt,
      archiveId: context.session.root.archiveId,
      rootSnapshotUpdatedAt: context.rootSnapshot?.updatedAt ?? null,
      rootSnapshot: cloneJson(context.rootSnapshot),
      targetRootUpdatedAt: context.targetRootUpdatedAt ?? null,
      targetRootDigest: context.targetRootDigest ?? null,
      trackedEntryCatalogs
    };
  }

  async persistPendingMutationJournal(context, { force = false } = {}) {
    if (!context?.journalEnabled) {
      return;
    }
    if (!force && !context.journalDirty) {
      return;
    }

    await context.session.metadataStore.writeMutationJournal(this.buildMutationJournalDocument(context));
    context.journalDirty = false;
    context.journalPersisted = true;
  }

  async clearMutationJournal(context = null, archivePath = null) {
    const targetStore = context?.session?.metadataStore || (this.state.archiveSession?.path === archivePath ? this.state.archiveSession.metadataStore : null);
    if (!targetStore && !archivePath) {
      return;
    }
    if (targetStore) {
      await targetStore.clearMutationJournal().catch(() => {});
    } else if (archivePath) {
      await deleteMutationJournal(archivePath).catch(() => {});
    }
    if (context) {
      context.journalDirty = false;
      context.journalPersisted = false;
    }
  }

  async loadPendingMutationJournal(archivePath, archiveKey) {
    let journal;
    try {
      journal = await readMutationJournal(archivePath, archiveKey);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Archive metadata mutation journal is unreadable: ${message}`);
    }

    if (!journal || typeof journal !== "object") {
      throw new Error("Archive metadata mutation journal is invalid");
    }
    if (journal.version !== MUTATION_JOURNAL_VERSION || journal.type !== "metadata-mutation" || journal.state !== "pending") {
      throw new Error("Archive metadata mutation journal has an unsupported format");
    }
    if (!journal.rootSnapshot || typeof journal.rootSnapshot !== "object") {
      throw new Error("Archive metadata mutation journal is missing root snapshot state");
    }
    if (
      !journal.trackedEntryCatalogs ||
      typeof journal.trackedEntryCatalogs !== "object" ||
      Array.isArray(journal.trackedEntryCatalogs)
    ) {
      throw new Error("Archive metadata mutation journal is missing tracked entry state");
    }

    return {
      journal
    };
  }

  async reconcilePendingMutationJournalOnOpen(archivePath, archiveKey, manifestEnvelope, root) {
    const pending = await this.loadPendingMutationJournal(archivePath, archiveKey);
    if (!pending) {
      return {
        root,
        recovered: false
      };
    }

    const { journal } = pending;
    if (journal.archiveId !== root.archiveId) {
      throw new Error("Archive metadata mutation journal does not match archive identity");
    }

    const currentRootDigest = hashMutationJournalRoot(root);
    const committedTargetDigest =
      typeof journal.targetRootDigest === "string" && journal.targetRootDigest.trim() ? journal.targetRootDigest : null;
    const rootDivergedFromSnapshot = JSON.stringify(root) !== JSON.stringify(journal.rootSnapshot);
    if ((committedTargetDigest && currentRootDigest === committedTargetDigest) || (!committedTargetDigest && rootDivergedFromSnapshot)) {
      await this.clearMutationJournal(null, archivePath);
      return {
        root,
        recovered: false
      };
    }

    const trackedEntries = Object.entries(journal.trackedEntryCatalogs);
    for (const [entryId, previousEntry] of trackedEntries.reverse()) {
      if (previousEntry) {
        await writeEntryCatalog(archivePath, archiveKey, previousEntry);
      } else {
        await deleteEntryCatalog(archivePath, entryId);
      }
    }

    await saveRootCatalog(archivePath, manifestEnvelope, archiveKey, journal.rootSnapshot);
    await this.clearMutationJournal(null, archivePath);
    const { root: recoveredRoot } = await loadArchiveCatalog(archivePath, archiveKey);
    return {
      root: recoveredRoot,
      recovered: true
    };
  }

  createMutationContext({ trackEntryCatalogs = true } = {}) {
    const session = this.requireArchiveSession();
    return {
      session,
      startedAt: new Date().toISOString(),
      rootSnapshot: cloneJson(session.root),
      trackEntryCatalogs,
      trackedEntryCatalogs: new Map(),
      snapshotRestored: false,
      journalEnabled: Boolean(trackEntryCatalogs),
      journalDirty: true,
      journalPersisted: false,
      targetRootUpdatedAt: null,
      targetRootDigest: null
    };
  }

  trackMutationEntryCatalogWrite(entryId, previousEntry) {
    const context = this.activeMutationContext;
    if (!context || !context.trackEntryCatalogs || context.trackedEntryCatalogs.has(entryId)) {
      return;
    }
    context.trackedEntryCatalogs.set(entryId, previousEntry ? cloneJson(previousEntry) : null);
    if (context.journalEnabled) {
      context.journalDirty = true;
    }
  }

  async rollbackTrackedEntryCatalogWrites(context) {
    if (!context || context.trackedEntryCatalogs.size === 0) {
      return;
    }
    const session = this.requireArchiveSession();
    for (const [entryId, previousEntry] of [...context.trackedEntryCatalogs.entries()].reverse()) {
      if (previousEntry) {
        await writeEntryCatalog(session.path, session.archiveKey, previousEntry);
      } else {
        await deleteEntryCatalog(session.path, entryId);
      }
    }
  }

  async restoreMutationSnapshot(context) {
    if (!context || context.snapshotRestored) {
      return;
    }
    this.restoreSessionRoot(context.rootSnapshot);
    this.resetEntryCaches();
    await this.rebuildDirectoryIndex();
    context.snapshotRestored = true;
  }

  async rollbackMutationContext(context, error, rollback = null) {
    if (typeof rollback === "function") {
      await rollback(context, error);
    }
    if (!context.snapshotRestored && context.trackEntryCatalogs) {
      await this.rollbackTrackedEntryCatalogWrites(context);
    }
    if (!context.snapshotRestored) {
      await this.restoreMutationSnapshot(context);
    }
  }

  shouldCommitMutationResult(result, commitWhen, context) {
    if (typeof commitWhen === "function") {
      return Boolean(commitWhen(result, context));
    }
    if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "changed")) {
      return Boolean(result.changed);
    }
    return true;
  }

  async executeMutationTransaction({
    mutate,
    rollback = null,
    afterCommit = null,
    commitWhen = null,
    trackEntryCatalogs = true
  }) {
    const context = this.createMutationContext({ trackEntryCatalogs });
    const metadataTransaction = await context.session.metadataStore.begin({
      rootSnapshot: context.rootSnapshot
    });
    const previousMutationContext = this.activeMutationContext;
    this.activeMutationContext = context;
    try {
      await this.persistPendingMutationJournal(context, { force: true });
      const transaction = createArchiveMutationTransaction({
        captureSnapshot: async () => context.rootSnapshot,
        restoreSnapshot: async () => {
          await context.session.metadataStore.rollback(metadataTransaction).catch(() => {});
          await this.rollbackMutationContext(context, null, rollback);
        },
        commitBoundary: async ({ result }) => {
          if (!this.shouldCommitMutationResult(result, commitWhen, context)) {
            return;
          }
          if (context.journalEnabled) {
            const committedAt = new Date().toISOString();
            context.session.root.updatedAt = committedAt;
            context.targetRootUpdatedAt = committedAt;
            context.targetRootDigest = hashMutationJournalRoot(context.session.root);
            context.journalDirty = true;
            await this.persistPendingMutationJournal(context, { force: true });
            await this.persistRoot({ updatedAt: committedAt });
          } else {
            await this.persistRoot();
          }
          context.committed = true;
          if (context.journalEnabled) {
            await this.clearMutationJournal(context).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              this.pushLog(`failed to clear metadata mutation journal: ${message}`);
            });
          }
        }
      });
      const result = await transaction.run(async () => mutate(context));
      if (context.journalEnabled && !context.committed) {
        await this.clearMutationJournal(context).catch(() => {});
      }
      if (context.committed && typeof afterCommit === "function") {
        await afterCommit(result, context);
      }
      return result;
    } catch (error) {
      if (context.journalEnabled && context.snapshotRestored) {
        await this.clearMutationJournal(context).catch(() => {});
      }
      throw error;
    } finally {
      await context.session.metadataStore.rollback(metadataTransaction).catch(() => {});
      this.activeMutationContext = previousMutationContext;
    }
  }

  async rollbackIngestMutation(rootSnapshot, mutation) {
    const session = this.requireArchiveSession();
    if (mutation?.beforeEntry) {
      const previousRevisionIds = new Set((mutation.beforeEntry.revisions || []).map((revision) => revision.id));
      for (const revision of mutation.afterEntry?.revisions || []) {
        if (previousRevisionIds.has(revision.id)) {
          continue;
        }
        await this.deleteRevisionPreviewArtifacts(mutation.afterEntry.id, revision.id);
        await session.objectStore.releaseArtifact(revision.originalArtifact);
        await session.objectStore.releaseArtifact(revision.optimizedArtifact);
      }
      await writeEntryCatalog(session.path, session.archiveKey, mutation.beforeEntry);
    } else if (mutation?.afterEntry) {
      await this.deleteEntryPreviewArtifacts(mutation.afterEntry);
      await session.objectStore.releaseEntry(mutation.afterEntry);
      await deleteEntryCatalog(session.path, mutation.afterEntry.id);
    }

    await session.objectStore.flushDirtyBuckets();
    this.restoreSessionRoot(rootSnapshot);
    this.resetEntryCaches();
    await this.rebuildDirectoryIndex();
  }

  async rollbackIngestBatch(rootSnapshot, mutations) {
    const session = this.requireArchiveSession();
    for (const mutation of [...mutations].reverse()) {
      if (mutation?.beforeEntry) {
        const previousRevisionIds = new Set((mutation.beforeEntry.revisions || []).map((revision) => revision.id));
        for (const revision of mutation.afterEntry?.revisions || []) {
          if (previousRevisionIds.has(revision.id)) {
            continue;
          }
          await this.deleteRevisionPreviewArtifacts(mutation.afterEntry.id, revision.id);
          await session.objectStore.releaseArtifact(revision.originalArtifact);
          await session.objectStore.releaseArtifact(revision.optimizedArtifact);
        }
        await writeEntryCatalog(session.path, session.archiveKey, mutation.beforeEntry);
        continue;
      }

      if (mutation?.afterEntry) {
        await this.deleteEntryPreviewArtifacts(mutation.afterEntry);
        await session.objectStore.releaseEntry(mutation.afterEntry);
        await deleteEntryCatalog(session.path, mutation.afterEntry.id);
      }
    }
    await session.objectStore.flushDirtyBuckets();
    this.restoreSessionRoot(rootSnapshot);
    this.resetEntryCaches();
    await this.rebuildDirectoryIndex();
  }

  pushLog(message) {
    const stamped = `${new Date().toISOString()} ${message}`;
    this.state.logs.push(stamped);
    this.state.logs = this.state.logs.slice(-200);
    if (this.state.archiveSession) {
      this.state.archiveSession.root.logs.push(stamped);
      this.state.archiveSession.root.logs = this.state.archiveSession.root.logs.slice(-200);
    }
  }

  clearAutoLockTimer() {
    if (!this.autoLockTimer) {
      return;
    }
    clearTimeout(this.autoLockTimer);
    this.autoLockTimer = null;
  }

  wipeArchiveKey(archiveKey) {
    if (!archiveKey || typeof archiveKey.fill !== "function") {
      return;
    }
    archiveKey.fill(0);
  }

  async cleanupOpenTempArtifacts(archiveId = null) {
    const targetPath = archiveId
      ? path.join(this.state.runtimeTempPath, OPEN_TEMP_DIRNAME, archiveId)
      : path.join(this.state.runtimeTempPath, OPEN_TEMP_DIRNAME);

    await fs.rm(targetPath, {
      recursive: true,
      force: true
    }).catch(() => {});

    if (!archiveId) {
      await ensureDir(path.join(this.state.runtimeTempPath, OPEN_TEMP_DIRNAME));
    }
  }

  async cleanupArchivePlaintextArtifacts(archiveId) {
    await this.cleanupOpenTempArtifacts(archiveId);
    await this.previewCache.deleteArchive(archiveId);
  }

  async disposeArchiveSession({ preserveLockedArchive = false } = {}) {
    this.clearAutoLockTimer();
    this.activeSessionOperations = 0;
    const activeSession = this.state.archiveSession;
    if (activeSession) {
      await this.cleanupArchivePlaintextArtifacts(activeSession.root.archiveId);
      this.wipeArchiveKey(activeSession.archiveKey);
    }
    this.state.archiveProgress = null;
    this.state.archiveSession = null;
    if (!preserveLockedArchive) {
      this.state.lockedArchive = null;
    }
  }

  async readArchiveManifest(archivePath) {
    const manifestRaw = await fs.readFile(path.join(archivePath, MANIFEST_FILENAME), "utf8").catch(() => null);
    if (!manifestRaw) {
      return null;
    }

    try {
      return JSON.parse(manifestRaw);
    } catch (_error) {
      return null;
    }
  }

  async isManagedArchiveDirectory(archivePath) {
    if (!archivePath || path.extname(archivePath) !== ".stow") {
      return false;
    }

    const manifest = await this.readArchiveManifest(archivePath);
    return Boolean(
      manifest &&
        manifest.version === MANIFEST_VERSION &&
        typeof manifest.catalog?.root === "string" &&
        manifest.catalog.root.length > 0
    );
  }

  requireArchiveSession() {
    if (!this.state.archiveSession) {
      throw new Error("No archive is open");
    }
    return this.state.archiveSession;
  }

  refreshSessionState({ touch = false, resetStartedAt = false } = {}) {
    const session = this.state.archiveSession;
    if (!session) {
      return;
    }

    session.root.sessionPolicy = normalizeSessionPolicy(session.root.sessionPolicy);

    const now = new Date().toISOString();
    const currentSession = session.session || {};
    const startedAt = resetStartedAt ? now : currentSession.startedAt || now;
    const lastActivityAt = touch ? now : currentSession.lastActivityAt || now;
    const archivePolicy = normalizeSessionPolicy(session.root.sessionPolicy);
    const effectivePolicy = resolveEffectiveSessionPolicy(this.state.settings, archivePolicy);
    const expiresAt = computeSessionExpiry(lastActivityAt, effectivePolicy.idleMinutes);

    session.session = {
      startedAt,
      lastActivityAt,
      expiresAt,
      archivePolicy,
      effectivePolicy
    };
  }

  scheduleAutoLockTimer() {
    this.clearAutoLockTimer();
    const session = this.state.archiveSession;
    if (!session || this.activeSessionOperations > 0) {
      return;
    }

    const expiresAt = session.session?.expiresAt;
    if (!expiresAt) {
      return;
    }

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }

    const delay = Math.max(250, expiresAtMs - Date.now());
    this.autoLockTimer = setTimeout(() => {
      void this.handleAutoLockTimeout();
    }, delay);

    if (typeof this.autoLockTimer.unref === "function") {
      this.autoLockTimer.unref();
    }
  }

  async handleAutoLockTimeout() {
    this.autoLockTimer = null;
    const session = this.state.archiveSession;
    if (!session) {
      return;
    }
    if (this.activeSessionOperations > 0) {
      this.scheduleAutoLockTimer();
      return;
    }

    const expiresAtMs = Date.parse(session.session?.expiresAt || "");
    if (!Number.isFinite(expiresAtMs) || Date.now() < expiresAtMs) {
      this.scheduleAutoLockTimer();
      return;
    }

    await this.lockArchive("auto-locked archive session after inactivity");
    this.emitShellState();
  }

  touchArchiveSession() {
    if (!this.state.archiveSession) {
      return;
    }
    this.refreshSessionState({ touch: true });
    this.scheduleAutoLockTimer();
  }

  beginSessionOperation() {
    this.activeSessionOperations += 1;
    this.clearAutoLockTimer();
  }

  endSessionOperation() {
    this.activeSessionOperations = Math.max(0, this.activeSessionOperations - 1);
    this.touchArchiveSession();
  }

  initializeArchiveSessionTimer() {
    this.refreshSessionState({ touch: true, resetStartedAt: true });
    this.scheduleAutoLockTimer();
  }

  createSession(pathname, archiveKey, encryption, manifestEnvelope, root) {
    const session = {
      path: pathname,
      archiveKey,
      encryption,
      manifestEnvelope,
      root: {
        ...root,
        folders: [...new Set(Array.isArray(root.folders) ? root.folders : [])].sort((left, right) => left.localeCompare(right)),
        preferences: normalizeArchivePreferences(root.preferences)
      },
      session: null,
      entryCache: new Map(),
      entryPathIndex: new Map(),
      entryPathIndexReady: false,
      directoryIndexReady: false,
      queryIndex: new ArchiveQueryIndex(),
      folderSet: new Set(),
      implicitFolders: new Set()
    };
    session.folderSet = new Set(session.root.folders);
    session.metadataStore = createMetadataStore(session);
    session.objectStore = new ObjectStore(session, this.state.capabilities);
    return session;
  }

  async persistRoot(options = {}) {
    const session = this.requireArchiveSession();
    session.root.updatedAt = options.updatedAt || new Date().toISOString();
    await session.metadataStore.commit({
      root: session.root,
      updatedAt: session.root.updatedAt
    });
    await this.persistEntrySummaryIndex().catch(() => {});
  }

  async loadEntry(entryId) {
    const session = this.requireArchiveSession();
    if (!session.entryCache.has(entryId)) {
      const entry = await session.metadataStore.getEntryById(entryId);
      session.entryCache.set(entryId, entry);
      if (entry?.relativePath) {
        session.entryPathIndex.set(entry.relativePath, entry.id);
      }
    }
    return session.entryCache.get(entryId);
  }

  async saveEntry(entry, options = {}) {
    const session = this.requireArchiveSession();
    const previousEntry = session.entryCache.get(entry.id);
    const previousEntrySnapshot =
      options.previousEntrySnapshot !== undefined
        ? options.previousEntrySnapshot
        : previousEntry
          ? cloneJson(previousEntry)
          : null;
    this.trackMutationEntryCatalogWrite(entry.id, previousEntrySnapshot);
    await this.persistPendingMutationJournal(this.activeMutationContext);
    const previousRelativePath =
      typeof options.previousRelativePath === "string"
        ? options.previousRelativePath
        : previousEntrySnapshot?.relativePath;
    session.entryCache.set(entry.id, entry);
    if (entry?.relativePath) {
      session.entryPathIndex.set(entry.relativePath, entry.id);
    }
    session.queryIndex.upsertEntry(buildEntrySummary(entry));
    // Query listings cache lightweight file summaries; any persisted entry write can affect list output.
    this.markDirectoryIndexDirty();
    await session.metadataStore.upsertEntry(entry);
  }

  async ensureEntryPathIndex() {
    const session = this.requireArchiveSession();
    if (session.entryPathIndexReady) {
      return;
    }
    await this.ensureDirectoryIndex();
    session.entryPathIndexReady = true;
  }

  async findEntryIdByRelativePath(relativePath) {
    const session = this.requireArchiveSession();
    const normalized = normalizeArchiveRelativePath(relativePath);
    return session.queryIndex.findEntryIdByRelativePath(normalized);
  }

  addFolderPath(folderPath) {
    const session = this.requireArchiveSession();
    const normalized = normalizeArchiveDirectoryPath(folderPath);
    if (!session.folderSet.has(normalized)) {
      session.root.folders.push(normalized);
      session.root.folders.sort((left, right) => left.localeCompare(right));
      session.folderSet.add(normalized);
      session.queryIndex.upsertFolder(normalized);
      this.markDirectoryIndexDirty();
    }
  }

  addImplicitFolderPath(folderPath) {
    const session = this.requireArchiveSession();
    const normalized = normalizeArchiveDirectoryPath(folderPath);
    const alreadyPresent = session.folderSet.has(normalized);
    this.addFolderPath(normalized);
    if (!alreadyPresent) {
      session.implicitFolders.add(normalized);
    }
  }

  ensureFolderAncestors(relativePath) {
    const parentPath = parentArchivePath(relativePath);
    if (!parentPath) {
      return;
    }

    const segments = parentPath.split(path.sep);
    for (let index = 0; index < segments.length; index += 1) {
      this.addImplicitFolderPath(segments.slice(0, index + 1).join(path.sep));
    }
  }

  async folderExists(folderPath) {
    const normalized = normalizeArchiveDirectoryPath(folderPath, { allowRoot: true });
    if (!normalized) {
      return true;
    }

    const session = this.requireArchiveSession();
    if (session.folderSet.has(normalized)) {
      return true;
    }
    return session.queryIndex.hasFolder(normalized);
  }

  async assertFolderExists(folderPath) {
    const normalized = normalizeArchiveDirectoryPath(folderPath, { allowRoot: true });
    if (!(await this.folderExists(normalized))) {
      throw new Error("Folder not found");
    }
    return normalized;
  }

  async relocateFolder(folderPath, nextRelativePath) {
    const session = this.requireArchiveSession();
    const normalizedFolderPath = normalizeArchiveDirectoryPath(folderPath);
    const normalizedTargetPath = normalizeArchiveDirectoryPath(nextRelativePath);
    if (!(await this.folderExists(normalizedFolderPath))) {
      throw new Error("Folder not found");
    }
    if (normalizedTargetPath === normalizedFolderPath) {
      return normalizedTargetPath;
    }

    const folderPrefix = `${normalizedFolderPath}${path.sep}`;
    if (normalizedTargetPath.startsWith(folderPrefix)) {
      throw new Error("A folder cannot be moved into itself");
    }
    if ((await this.folderExists(normalizedTargetPath)) || (await this.findEntryIdByRelativePath(normalizedTargetPath))) {
      throw new Error("A folder or file with that name already exists in the destination");
    }

    session.root.folders = [...new Set(session.root.folders.map((candidate) => {
      if (candidate === normalizedFolderPath) {
        return normalizedTargetPath;
      }
      if (candidate.startsWith(folderPrefix)) {
        return path.join(normalizedTargetPath, candidate.slice(folderPrefix.length));
      }
      return candidate;
    }))].sort((left, right) => left.localeCompare(right));

    for (const entryId of session.root.entryOrder) {
      const entry = await this.loadEntry(entryId);
      if (!entry?.relativePath.startsWith(folderPrefix)) {
        continue;
      }
      const previousEntrySnapshot = cloneJson(entry);
      const previousRelativePath = entry.relativePath;
      entry.relativePath = path.join(normalizedTargetPath, entry.relativePath.slice(folderPrefix.length));
      entry.name = path.basename(entry.relativePath);
      session.entryPathIndex.delete(previousRelativePath);
      await this.saveEntry(entry, { previousRelativePath, previousEntrySnapshot });
    }

    session.folderSet = new Set(session.root.folders);
    session.implicitFolders = new Set(
      [...session.implicitFolders].map((candidate) => {
        if (candidate === normalizedFolderPath) {
          return normalizedTargetPath;
        }
        if (candidate.startsWith(folderPrefix)) {
          return path.join(normalizedTargetPath, candidate.slice(folderPrefix.length));
        }
        return candidate;
      })
    );
    this.refreshQueryIndexFolders();

    return normalizedTargetPath;
  }

  stageStoredEntryDeletion(entry) {
    const session = this.requireArchiveSession();
    session.root.entryOrder = session.root.entryOrder.filter((candidate) => candidate !== entry.id);
    session.root.stats.entryCount = Math.max(0, session.root.stats.entryCount - 1);
    session.root.stats.logicalBytes = Math.max(0, session.root.stats.logicalBytes - entry.size);
    session.entryPathIndex.delete(entry.relativePath);
    session.entryCache.delete(entry.id);
    session.queryIndex.removeEntry(entry.id);
    this.markDirectoryIndexDirty();
  }

  async finalizeStoredEntryDeletions(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    const session = this.requireArchiveSession();
    for (const entry of entries) {
      await this.deleteEntryPreviewArtifacts(entry);
      await session.objectStore.releaseEntry(entry);
      await deleteEntryCatalog(session.path, entry.id);
    }
    await session.objectStore.flushDirtyBuckets();
  }

  async deleteEntry(entryId) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }

      await this.executeMutationTransaction({
        mutate: async () => {
          this.stageStoredEntryDeletion(entry);
          this.pushLog(`deleted ${entry.relativePath} from archive`);
          return {
            changed: true,
            entry
          };
        },
        afterCommit: async ({ entry: deletedEntry }, context) => {
          await this.finalizeStoredEntryDeletions([deletedEntry]);
          this.emitEntriesInvalidated({
            archiveId: context.session.root.archiveId,
            reason: "delete",
            selectedEntryId: context.session.root.entryOrder[0] || null
          });
        }
      });
    } finally {
      this.endSessionOperation();
    }
  }

  async deleteFolder(folderPath) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const normalized = normalizeArchiveDirectoryPath(folderPath);
      if (!(await this.folderExists(normalized))) {
        throw new Error("Folder not found");
      }

      const folderPrefix = `${normalized}${path.sep}`;
      const entriesToDelete = [];
      const session = this.requireArchiveSession();
      for (const entryId of session.root.entryOrder) {
        const entry = await this.loadEntry(entryId);
        if (entry?.relativePath.startsWith(folderPrefix)) {
          entriesToDelete.push(entry);
        }
      }

      await this.executeMutationTransaction({
        mutate: async () => {
          for (const entry of entriesToDelete) {
            this.stageStoredEntryDeletion(entry);
          }

          session.root.folders = session.root.folders.filter(
            (candidate) => candidate !== normalized && !candidate.startsWith(folderPrefix)
          );
          session.folderSet = new Set(session.root.folders);
          session.implicitFolders = new Set(
            [...session.implicitFolders].filter((candidate) => candidate !== normalized && !candidate.startsWith(folderPrefix))
          );
          this.refreshQueryIndexFolders();

          await this.pruneEmptyImplicitFoldersFrom(parentArchivePath(normalized));
          this.pushLog(`deleted folder ${normalized} from archive`);
          return {
            changed: true,
            entriesToDelete
          };
        },
        afterCommit: async ({ entriesToDelete: deletedEntries }, context) => {
          await this.finalizeStoredEntryDeletions(deletedEntries);
          this.emitEntriesInvalidated({
            archiveId: context.session.root.archiveId,
            reason: "folder-delete",
            selectedEntryId: context.session.root.entryOrder[0] || null
          });
        }
      });
    } finally {
      this.endSessionOperation();
    }
  }

  async renameEntry(entryId, nextName) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const result = await this.executeMutationTransaction({
        mutate: async () => {
          const folderPath = parseFolderEntryId(entryId);
          if (folderPath !== null) {
            const normalizedFolderPath = normalizeArchiveDirectoryPath(folderPath);
            const normalizedName = validateEntryRename(nextName);
            const parentPath = parentArchivePath(normalizedFolderPath);
            const nextRelativePath = parentPath ? path.join(parentPath, normalizedName) : normalizedName;
            if (nextRelativePath === normalizedFolderPath) {
              return { changed: false };
            }

            await this.relocateFolder(normalizedFolderPath, nextRelativePath);
            await this.pruneEmptyImplicitFoldersFrom(parentPath);
            this.pushLog(`renamed folder ${normalizedFolderPath} to ${nextRelativePath}`);
            return {
              changed: true,
              reason: "folder-rename",
              selectedEntryId: null
            };
          }

          const entry = await this.loadEntry(entryId);
          if (!entry) {
            throw new Error("Entry not found");
          }

          const normalizedName = validateEntryRename(nextName);
          if (normalizedName === entry.name) {
            return { changed: false };
          }

          const parentPath = path.dirname(entry.relativePath);
          const nextRelativePath = parentPath === "." ? normalizedName : path.join(parentPath, normalizedName);

          const existingEntryId = await this.findEntryIdByRelativePath(nextRelativePath);
          if (existingEntryId && existingEntryId !== entryId) {
            throw new Error("An entry with that name already exists in this folder");
          }

          const previousEntrySnapshot = cloneJson(entry);
          const previousRelativePath = entry.relativePath;
          entry.name = normalizedName;
          entry.relativePath = nextRelativePath;
          session.entryPathIndex.delete(previousRelativePath);
          await this.saveEntry(entry, { previousRelativePath, previousEntrySnapshot });
          await this.pruneEmptyImplicitFoldersFrom(parentArchivePath(previousRelativePath));
          this.pushLog(`renamed ${previousRelativePath} to ${nextRelativePath}`);
          return {
            changed: true,
            reason: "rename",
            selectedEntryId: entry.id
          };
        }
      });
      if (result?.changed) {
        this.emitEntriesInvalidated({
          archiveId: session.root.archiveId,
          reason: result.reason,
          selectedEntryId: result.selectedEntryId
        });
      }
    } finally {
      this.endSessionOperation();
    }
  }

  async createFolder(relativePath) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const result = await this.executeMutationTransaction({
        mutate: async () => {
          const normalized = validateArchiveDirectoryNames(relativePath);
          if (await this.findEntryIdByRelativePath(normalized)) {
            throw new Error("A file already exists at that path");
          }
          if (await this.folderExists(normalized)) {
            throw new Error("Folder already exists");
          }

          this.ensureFolderAncestors(normalized);
          this.addFolderPath(normalized);
          this.pushLog(`created folder ${normalized}`);
          return {
            changed: true
          };
        }
      });
      if (result?.changed) {
        this.emitEntriesInvalidated({
          archiveId: session.root.archiveId,
          reason: "folder-create",
          selectedEntryId: null
        });
      }
    } finally {
      this.endSessionOperation();
    }
  }

  async moveEntry(entryId, destinationDirectory) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const result = await this.executeMutationTransaction({
        mutate: async () => {
          const folderPath = parseFolderEntryId(entryId);
          if (folderPath !== null) {
            const normalizedFolderPath = normalizeArchiveDirectoryPath(folderPath);
            const normalizedDirectory = await this.assertFolderExists(destinationDirectory);
            const nextRelativePath = normalizedDirectory
              ? path.join(normalizedDirectory, folderName(normalizedFolderPath))
              : folderName(normalizedFolderPath);
            if (nextRelativePath === normalizedFolderPath) {
              return { changed: false };
            }

            await this.relocateFolder(normalizedFolderPath, nextRelativePath);
            await this.pruneEmptyImplicitFoldersFrom(parentArchivePath(normalizedFolderPath));
            this.pushLog(`moved folder ${normalizedFolderPath} to ${nextRelativePath}`);
            return {
              changed: true,
              reason: "folder-move",
              selectedEntryId: null
            };
          }

          const entry = await this.loadEntry(entryId);
          if (!entry) {
            throw new Error("Entry not found");
          }

          const normalizedDirectory = await this.assertFolderExists(destinationDirectory);
          const nextRelativePath = normalizedDirectory ? path.join(normalizedDirectory, entry.name) : entry.name;
          if (nextRelativePath === entry.relativePath) {
            return { changed: false };
          }

          const existingEntryId = await this.findEntryIdByRelativePath(nextRelativePath);
          if (existingEntryId && existingEntryId !== entryId) {
            throw new Error("An entry with that name already exists in the destination folder");
          }

          const previousEntrySnapshot = cloneJson(entry);
          const previousRelativePath = entry.relativePath;
          entry.relativePath = nextRelativePath;
          session.entryPathIndex.delete(previousRelativePath);
          this.ensureFolderAncestors(nextRelativePath);
          await this.saveEntry(entry, { previousRelativePath, previousEntrySnapshot });
          await this.pruneEmptyImplicitFoldersFrom(parentArchivePath(previousRelativePath));
          this.pushLog(`moved ${previousRelativePath} to ${nextRelativePath}`);
          return {
            changed: true,
            reason: "move",
            selectedEntryId: entry.id
          };
        }
      });
      if (result?.changed) {
        this.emitEntriesInvalidated({
          archiveId: session.root.archiveId,
          reason: result.reason,
          selectedEntryId: result.selectedEntryId
        });
      }
    } finally {
      this.endSessionOperation();
    }
  }

  async saveSettings(settings) {
    this.state.settings = normalizeSettings(
      {
        ...this.state.settings,
        ...settings
      },
      this.state.defaultArchiveRoot
    );
    this.refreshSessionState();
    this.scheduleAutoLockTimer();
    await writeJson(this.state.settingsPath, this.state.settings);
  }

  async resetSettings() {
    this.state.settings = normalizeSettings(
      {
        ...DEFAULT_SETTINGS,
        preferredArchiveRoot: this.state.defaultArchiveRoot
      },
      this.state.defaultArchiveRoot
    );
    this.refreshSessionState();
    this.scheduleAutoLockTimer();
    await writeJson(this.state.settingsPath, this.state.settings);
    this.pushLog("restored default preferences");
  }

  async setArchivePreferences(preferences) {
    const session = this.requireArchiveSession();
    const nextPreferences = normalizeArchivePreferences({
      ...session.root.preferences,
      ...(preferences && typeof preferences === "object" ? preferences : {})
    });

    session.root.preferences = nextPreferences;
    this.pushLog("updated archive optimization preferences");
    await this.persistRoot();
  }

  async persistRecentArchives() {
    this.state.recentArchives = this.state.recentArchives.slice(0, MAX_RECENT_ARCHIVES);
    await saveRecentArchives(this.state.recentArchivesPath, this.state.recentArchives);
  }

  async trackRecentArchive(archivePath, archiveName) {
    const nextArchive = {
      path: archivePath,
      name: archiveName,
      lastOpenedAt: new Date().toISOString()
    };
    this.state.recentArchives = [
      nextArchive,
      ...this.state.recentArchives.filter((candidate) => path.resolve(candidate.path) !== path.resolve(archivePath))
    ].slice(0, MAX_RECENT_ARCHIVES);
    await this.persistRecentArchives();
  }

  async removeRecentArchive(archivePath) {
    this.state.recentArchives = this.state.recentArchives.filter(
      (candidate) => path.resolve(candidate.path) !== path.resolve(archivePath)
    );
    await this.persistRecentArchives();
  }

  async deleteArchive(archivePath) {
    const targetPath = path.resolve(archivePath);
    const currentArchivePath = this.state.archiveSession ? path.resolve(this.state.archiveSession.path) : null;
    const lockedArchivePath = this.state.lockedArchive ? path.resolve(this.state.lockedArchive.path) : null;

    if (!(await exists(targetPath))) {
      throw new Error("Archive not found");
    }
    if (!(await isDirectory(targetPath))) {
      throw new Error("Archive path is not a directory");
    }
    if (!(await this.isManagedArchiveDirectory(targetPath))) {
      throw new Error("Refusing to delete a directory that is not a valid Stow archive");
    }

    if (currentArchivePath === targetPath || lockedArchivePath === targetPath) {
      await this.disposeArchiveSession();
    }

    await fs.rm(targetPath, { recursive: true, force: true });
    await this.removeRecentArchive(targetPath);
    this.pushLog(`deleted archive at ${targetPath}`);
  }

  async createArchive({ parentPath, name, password, preferences }) {
    const resolvedParentPath = path.resolve(parentPath);
    const normalizedName = validateArchiveName(name);
    if (!(await isDirectory(resolvedParentPath))) {
      throw new Error("Archive parent path is not a directory");
    }

    const archivePath = path.join(resolvedParentPath, `${normalizedName}.stow`);
    if (await exists(archivePath)) {
      throw new Error("Archive path already exists");
    }

    await ensureDir(archivePath);
    const mergedSettings = normalizeSettings(
      {
        ...this.state.settings,
        ...preferences
      },
      this.state.defaultArchiveRoot
    );
    const archivePreferences = normalizeArchivePreferences(mergedSettings);
    const encryption = await createArchiveEncryption(password, mergedSettings.argonProfile);
    const { manifestEnvelope, root } = await createArchiveCatalog({
      archivePath,
      encryptionHeader: {
        ...encryption.header,
        profile: mergedSettings.argonProfile
      },
      archiveKey: encryption.archiveKey,
      name: normalizedName,
      preferences: archivePreferences
    });

    await this.disposeArchiveSession();
    this.state.archiveSession = this.createSession(
      archivePath,
      encryption.archiveKey,
      manifestEnvelope.encryption,
      manifestEnvelope,
      root
    );
    await this.initializeQueryIndexForSession();
    this.initializeArchiveSessionTimer();
    await this.trackRecentArchive(archivePath, normalizedName);
    this.pushLog(`created archive at ${archivePath}`);
    await this.persistRoot();
  }

  async openArchive({ archivePath, password }) {
    const manifest = await this.readArchiveManifest(archivePath);
    if (!manifest) {
      throw new Error("Archive manifest not found");
    }

    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`Unsupported archive version ${manifest.version ?? "unknown"}. Stow vNext only opens v3 archives.`);
    }

    const archiveKey = await unlockArchiveKey(password, manifest.encryption);
    const metadataStoreKind = (process.env.STOW_METADATA_STORE || "").trim().toLowerCase();
    const storeType = metadataStoreKind === "sqlite" ? SqliteMetadataStore : JsonMetadataStore;
    const { manifestEnvelope, root: loadedRoot } = await storeType.loadArchive(archivePath, archiveKey);
    const { root, recovered } = await this.reconcilePendingMutationJournalOnOpen(
      archivePath,
      archiveKey,
      manifestEnvelope,
      loadedRoot
    );

    await this.disposeArchiveSession();
    this.state.archiveSession = this.createSession(
      archivePath,
      archiveKey,
      manifestEnvelope.encryption,
      manifestEnvelope,
      root
    );
    await this.state.archiveSession.objectStore.reconcileStorage();
    await this.initializeQueryIndexForSession();
    this.initializeArchiveSessionTimer();
    await this.trackRecentArchive(archivePath, root.name);
    if (recovered) {
      this.pushLog(`recovered archive metadata from an interrupted mutation for ${root.name}`);
    }
    this.pushLog(`opened archive ${root.name}`);
  }

  async lockArchive(reason = "locked archive session") {
    if (!this.state.archiveSession) {
      return;
    }
    const archivePath = this.state.archiveSession.path;
    const archiveName = this.state.archiveSession.root.name;
    await this.disposeArchiveSession({ preserveLockedArchive: true });
    this.state.lockedArchive = {
      path: archivePath
    };
    this.pushLog(`${reason} (${archiveName})`);
  }

  async closeArchive() {
    await this.lockArchive("manually locked archive session");
  }

  async addPaths(paths, options = {}) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    let completedFiles = 0;
    let totalFiles = 0;
    const appliedMutations = [];
    const uploadedSourcePaths = new Set();
    try {
      const deleteOriginals =
        typeof options.deleteOriginalFilesAfterSuccessfulUpload === "boolean"
          ? options.deleteOriginalFilesAfterSuccessfulUpload
          : this.state.settings.deleteOriginalFilesAfterSuccessfulUpload;
      const destinationDirectory = Object.prototype.hasOwnProperty.call(options, "destinationDirectory")
        ? await this.assertFolderExists(options.destinationDirectory)
        : "";

      const inputFiles = await collectInputFiles(paths, destinationDirectory);
      totalFiles = inputFiles.length;
      const result = await this.executeMutationTransaction({
        trackEntryCatalogs: false,
        mutate: async () => {
          let ingestedAny = false;
          await withTempDir("stow-ingest-", async (tempDir) => {
            this.emitProgress({
              active: true,
              phase: "preparing",
              currentFile: null,
              completedFiles: 0,
              totalFiles
            });

            for (const file of inputFiles) {
              ingestedAny = true;
              uploadedSourcePaths.add(file.absolutePath);
              this.emitProgress({
                active: true,
                phase: "processing",
                currentFile: file.relativePath,
                completedFiles,
                totalFiles
              });
              this.touchArchiveSession();
              const normalizedRelativePath = normalizeArchiveRelativePath(file.relativePath);
              const existingEntryId = await this.findEntryIdByRelativePath(normalizedRelativePath);
              const previousEntry = existingEntryId ? cloneJson(await this.loadEntry(existingEntryId)) : null;
              const entryId = await this.ingestSource({
                absolutePath: file.absolutePath,
                relativePath: file.relativePath,
                tempDir,
                existingEntryId: null,
                overrideMode: null
              });
              appliedMutations.push({
                beforeEntry: previousEntry,
                afterEntry: cloneJson(await this.loadEntry(entryId))
              });
              completedFiles += 1;
            }
          });
          return {
            changed: ingestedAny,
            ingestedAny
          };
        },
        rollback: async (context) => {
          await this.rollbackIngestBatch(context.rootSnapshot, appliedMutations);
          context.snapshotRestored = true;
        },
        afterCommit: async (_mutationResult, context) => {
          if (deleteOriginals) {
            await this.deleteUploadedSourceFiles([...uploadedSourcePaths]);
          }
          this.emitEntriesInvalidated({
            archiveId: context.session.root.archiveId,
            reason: "ingest",
            selectedEntryId: context.session.root.entryOrder[0] || null
          });
        }
      });
      if (!result?.ingestedAny) {
        return;
      }
    } finally {
      this.emitProgress({
        active: false,
        phase: "processing",
        currentFile: null,
        completedFiles,
        totalFiles
      });
      this.endSessionOperation();
    }
  }

  async deleteUploadedSourceFiles(sourcePaths) {
    const uniqueSourcePaths = [...new Set(sourcePaths)];
    if (!uniqueSourcePaths.length) {
      return;
    }

    const results = await Promise.allSettled(uniqueSourcePaths.map((sourcePath) => fs.rm(sourcePath, { force: true })));
    const failed = results
      .map((result, index) => ({ result, sourcePath: uniqueSourcePaths[index] }))
      .filter(({ result }) => result.status === "rejected");

    const deletedCount = results.length - failed.length;
    if (failed.length === 0) {
      this.pushLog(`deleted ${deletedCount} original file${deletedCount === 1 ? "" : "s"} after upload`);
      return;
    }

    const firstError = failed[0].result.reason;
    const failedPath = failed[0].sourcePath;
    const message = firstError instanceof Error ? firstError.message : String(firstError);
    this.pushLog(
      `deleted ${deletedCount} original file${deletedCount === 1 ? "" : "s"} after upload; failed to delete ${failed.length} (${failedPath}): ${message}`
    );
  }

  buildStorageActions(label, artifact) {
    const stats = artifact.storageStats;
    const dedupeAction =
      stats.reusedChunks > 0
        ? `${label}: deduped ${stats.reusedChunks}/${stats.totalChunks} chunks`
        : `${label}: no reusable chunks found`;
    const compressionAction =
      stats.storedBytes > 0
        ? `${label}: compressed and encrypted ${stats.storedBytes} stored bytes`
        : `${label}: stored via existing encrypted chunks`;
    return [dedupeAction, compressionAction];
  }

  async ingestSource({ absolutePath, relativePath, tempDir, existingEntryId, overrideMode }) {
    const session = this.requireArchiveSession();
    const normalizedRelativePath = normalizeArchiveRelativePath(relativePath);
    this.ensureFolderAncestors(normalizedRelativePath);
    const collidingEntryId = existingEntryId ? null : await this.findEntryIdByRelativePath(normalizedRelativePath);
    const entryId = existingEntryId || collidingEntryId || uuid();
    const preferences = {
      ...session.root.preferences,
      ...(overrideMode ? { optimizationMode: overrideMode } : {})
    };
    const analysis = await analyzePath(absolutePath, preferences, this.state.capabilities, tempDir);
    const stats = await fs.stat(absolutePath);
    const revisionId = uuid();

    const originalArtifact = await session.objectStore.storeFile(
      analysis.original.path,
      session.root.preferences.compressionBehavior,
      {
        extension: analysis.original.extension,
        mime: analysis.original.mime
      }
    );

    let derivativeArtifact = null;
    if (analysis.derivative?.path) {
      derivativeArtifact = await session.objectStore.storeFile(
        analysis.derivative.path,
        session.root.preferences.compressionBehavior,
        {
          extension: analysis.derivative.extension,
          mime: analysis.derivative.mime
        }
      );
    }

    const nextRevision = {
      id: revisionId,
      addedAt: new Date().toISOString(),
      source: {
        relativePath: normalizedRelativePath,
        size: stats.size
      },
      media: {
        width: analysis.original.width || null,
        height: analysis.original.height || null,
        codec: analysis.original.codec || null
      },
      overrideMode: overrideMode || null,
      summary: analysis.summary,
      actions: [
        overrideMode ? `per-file override ${overrideMode}` : "used archive defaults",
        collidingEntryId ? "path collision policy stored a new revision for the existing archive path" : "created archive file-tree entry",
        "preserved original",
        ...analysis.actions,
        ...this.buildStorageActions("original", originalArtifact),
        ...(derivativeArtifact ? this.buildStorageActions("optimized", derivativeArtifact) : ["optimized: no derivative stored"]),
        derivativeArtifact ? "stored optimized derivative" : "no optimized derivative"
      ],
      originalArtifact: {
        label: "original",
        extension: analysis.original.extension,
        mime: analysis.original.mime,
        ...originalArtifact
      },
      optimizedArtifact: derivativeArtifact
        ? {
            label: analysis.derivative.label,
            extension: analysis.derivative.extension,
            mime: analysis.derivative.mime,
            actions: analysis.derivative.actions,
            ...derivativeArtifact
          }
        : null
    };

    if (entryId !== null && (existingEntryId || collidingEntryId)) {
      const existingEntry = await this.loadEntry(entryId);
      const previousRelativePath = existingEntry.relativePath;
      session.root.stats.logicalBytes += stats.size - existingEntry.size;
      session.root.entryOrder = [entryId, ...session.root.entryOrder.filter((candidate) => candidate !== entryId)];
      existingEntry.latestRevisionId = revisionId;
      existingEntry.name = path.basename(normalizedRelativePath);
      existingEntry.relativePath = normalizedRelativePath;
      existingEntry.size = stats.size;
      existingEntry.mime = analysis.original.mime;
      existingEntry.fileKind = analysis.kind;
      existingEntry.revisions.unshift(nextRevision);
      await this.saveEntry(existingEntry, { previousRelativePath });
      await this.cacheRevisionPreviews(existingEntry.id, revisionId, analysis.kind, analysis.previewSourcePath || analysis.original.path);
      this.pushLog(
        existingEntryId
          ? `reprocessed ${normalizedRelativePath} with override ${overrideMode}`
          : `ingested ${normalizedRelativePath} as a new revision for the existing archive path`
      );
      return existingEntry.id;
    }

    const entry = {
      id: entryId,
      name: path.basename(normalizedRelativePath),
      relativePath: normalizedRelativePath,
      fileKind: analysis.kind,
      mime: analysis.original.mime,
      size: stats.size,
      createdAt: new Date().toISOString(),
      latestRevisionId: revisionId,
      revisions: [nextRevision]
    };
    session.root.entryOrder.unshift(entryId);
    session.root.stats.entryCount += 1;
    session.root.stats.logicalBytes += stats.size;
    await this.saveEntry(entry);
    await this.cacheRevisionPreviews(entryId, revisionId, analysis.kind, analysis.previewSourcePath || analysis.original.path);
    this.pushLog(`ingested ${normalizedRelativePath} (${analysis.kind})`);
    return entryId;
  }

  async listEntries({ directory = "", offset = 0, limit = 100, sortColumn = "name", sortDirection = "asc" }) {
    const session = this.requireArchiveSession();
    const normalizedDirectory = await this.assertFolderExists(directory);
    return session.metadataStore.listEntries({
      directory: normalizedDirectory,
      offset,
      limit,
      sortColumn,
      sortDirection
    });
  }

  async getEntryDetail(entryId) {
    const entry = await this.loadEntry(entryId);
    if (!entry) {
      throw new Error("Entry not found");
    }
    return buildEntryDetail(entry);
  }

  async getStats() {
    const session = this.requireArchiveSession();
    return {
      ...session.root.stats,
      updatedAt: session.root.updatedAt
    };
  }

  async exportEntry(entryId, variant, destination) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }
      const revision = entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId);
      const descriptor =
        variant === "optimized" && revision.optimizedArtifact ? revision.optimizedArtifact : revision.originalArtifact;
      const safeName = entry.name.replace(path.extname(entry.name), "");
      const extension = descriptor.extension || path.extname(entry.name);
      const exportPath = path.join(destination, `${safeName}${variant === "optimized" ? "-optimized" : "-original"}${extension}`);
      await this.requireArchiveSession().objectStore.materializeObjectToFile(descriptor, exportPath);
      this.pushLog(`exported ${entry.relativePath} as ${path.basename(exportPath)}`);
    } finally {
      this.endSessionOperation();
    }
  }

  async openEntryExternally(entryId) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }
      const revision = entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId);
      if (!revision) {
        throw new Error("Revision not found");
      }

      const descriptor = revision.originalArtifact;
      const openRoot = path.join(this.state.runtimeTempPath, OPEN_TEMP_DIRNAME, session.root.archiveId);
      await ensureDir(openRoot);
      const outputPath = path.join(openRoot, `${uuid()}-${entryFileName(entry, descriptor)}`);
      await session.objectStore.materializeObjectToFile(descriptor, outputPath);
      await spawnOpenFile(outputPath);
      this.pushLog(`opened ${entry.relativePath} in the system default app`);
    } finally {
      this.endSessionOperation();
    }
  }

  async resolveEntryPreview(entryId, previewKind = "preview") {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }
      const revision = entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId);
      if (!revision) {
        throw new Error("Revision not found");
      }
      const previewFileKind = getEntryPreviewKind(entry);
      if (!previewFileKind) {
        return null;
      }

      const key = {
        archiveId: session.root.archiveId,
        entryId: entry.id,
        revisionId: revision.id,
        kind: previewKind
      };
      const cached = await this.previewCache.getDescriptor(key);
      if (cached) {
        return cached;
      }

      const descriptor = await withTempDir("stow-preview-source-", async (tempDir) => {
        const previewArtifact =
          previewFileKind === "video" && revision.optimizedArtifact ? revision.optimizedArtifact : revision.originalArtifact;
        const sourcePath = await session.objectStore.materializeObjectToTempPath(
          previewArtifact,
          previewArtifact.extension || path.extname(entry.name),
          "stow-preview-materialized-"
        );
        try {
          const outputDir = this.previewCache.previewDir(key);
          await ensureDir(outputDir);
          const preview = await generatePreviewFile(sourcePath, previewFileKind, previewKind, outputDir, this.state.capabilities);
          if (!preview) {
            return null;
          }

          return this.previewCache.writeDescriptor(key, {
            path: preview.path,
            mime: preview.mime,
            revisionId: revision.id,
            kind: previewKind
          });
        } finally {
          await fs.rm(path.dirname(sourcePath), { recursive: true, force: true }).catch(() => {});
        }
      });

      return descriptor;
    } finally {
      this.endSessionOperation();
    }
  }

  async reprocessEntry(entryId, overrideMode) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }
      const previousEntry = cloneJson(entry);

      let mutation = null;
      await this.executeMutationTransaction({
        trackEntryCatalogs: false,
        mutate: async () => {
          const latestRevision = entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId) ?? entry.revisions[0];
          if (!latestRevision?.originalArtifact) {
            throw new Error("Original stored artifact is not available for reprocessing");
          }

          const materializedSourcePath = await session.objectStore.materializeObjectToTempPath(
            latestRevision.originalArtifact,
            latestRevision.originalArtifact.extension || path.extname(entry.name),
            "stow-reprocess-source-"
          );
          try {
            await withTempDir("stow-reprocess-", async (tempDir) => {
              await this.ingestSource({
                absolutePath: materializedSourcePath,
                relativePath: entry.relativePath,
                tempDir,
                existingEntryId: entry.id,
                overrideMode
              });
            });
            mutation = {
              beforeEntry: previousEntry,
              afterEntry: cloneJson(await this.loadEntry(entry.id))
            };
          } finally {
            await fs.rm(path.dirname(materializedSourcePath), { recursive: true, force: true }).catch(() => {});
          }
          return {
            changed: true,
            selectedEntryId: entry.id
          };
        },
        rollback: async (context) => {
          await this.rollbackIngestMutation(context.rootSnapshot, mutation);
          context.snapshotRestored = true;
        },
        afterCommit: async ({ selectedEntryId }, context) => {
          this.emitEntriesInvalidated({
            archiveId: context.session.root.archiveId,
            reason: "reprocess",
            selectedEntryId
          });
        }
      });
    } finally {
      this.endSessionOperation();
    }
  }

  async setArchiveSessionPolicy(policy) {
    const session = this.requireArchiveSession();
    const input = policy && typeof policy === "object" ? policy : {};
    const currentPolicy = normalizeSessionPolicy(session.root.sessionPolicy);
    const nextPolicy = {
      idleMinutes: Object.prototype.hasOwnProperty.call(input, "idleMinutes")
        ? normalizeIdleMinutes(input.idleMinutes, null)
        : currentPolicy.idleMinutes,
      lockOnHide: Object.prototype.hasOwnProperty.call(input, "lockOnHide")
        ? typeof input.lockOnHide === "boolean"
          ? input.lockOnHide
          : null
        : currentPolicy.lockOnHide
    };

    session.root.sessionPolicy = nextPolicy;
    this.refreshSessionState();
    this.scheduleAutoLockTimer();
    this.pushLog("updated archive session policy");
    await this.persistRoot();
  }

  async deleteEntries(entryIds) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const uniqueIds = [...new Set(entryIds)];
      const entries = [];
      for (const entryId of uniqueIds) {
        const entry = await this.loadEntry(entryId);
        if (!entry) {
          throw new Error(`Entry not found: ${entryId}`);
        }
        entries.push(entry);
      }

      await this.executeMutationTransaction({
        mutate: async () => {
          for (const entry of entries) {
            this.stageStoredEntryDeletion(entry);
          }

          this.pushLog(`deleted ${entries.length} ${entries.length === 1 ? "entry" : "entries"} from archive`);
          return {
            changed: true,
            entries
          };
        },
        afterCommit: async ({ entries: deletedEntries }, context) => {
          await this.finalizeStoredEntryDeletions(deletedEntries);
          this.emitEntriesInvalidated({
            archiveId: context.session.root.archiveId,
            reason: "bulk-delete",
            selectedEntryId: context.session.root.entryOrder[0] || null
          });
        }
      });
    } finally {
      this.endSessionOperation();
    }
  }

  async moveEntries(entryIds, destinationDirectory) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const result = await this.executeMutationTransaction({
        mutate: async () => {
          const session = this.requireArchiveSession();
          const normalizedDirectory = await this.assertFolderExists(destinationDirectory);
          const uniqueIds = [...new Set(entryIds)];
          const entries = [];
          const folderPaths = [];
          for (const entryId of uniqueIds) {
            const folderPath = parseFolderEntryId(entryId);
            if (folderPath !== null) {
              folderPaths.push(normalizeArchiveDirectoryPath(folderPath));
              continue;
            }
            const entry = await this.loadEntry(entryId);
            if (!entry) {
              throw new Error(`Entry not found: ${entryId}`);
            }
            entries.push(entry);
          }

          const rootFolderMoves = [...new Set(folderPaths)]
            .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)
            .filter(
              (folderPath, index, allFolders) =>
                !allFolders.slice(0, index).some((candidate) => folderPath.startsWith(`${candidate}${path.sep}`))
            );

          for (const folderPath of rootFolderMoves) {
            const nextRelativePath = normalizedDirectory
              ? path.join(normalizedDirectory, folderName(folderPath))
              : folderName(folderPath);
            if (nextRelativePath === folderPath) {
              continue;
            }
            await this.relocateFolder(folderPath, nextRelativePath);
          }

          for (const entry of entries) {
            const nextRelativePath = normalizedDirectory ? path.join(normalizedDirectory, entry.name) : entry.name;
            if (nextRelativePath === entry.relativePath) {
              continue;
            }
            const existingEntryId = await this.findEntryIdByRelativePath(nextRelativePath);
            if (existingEntryId && existingEntryId !== entry.id) {
              throw new Error(`An entry named "${entry.name}" already exists in the destination folder`);
            }
            const previousEntrySnapshot = cloneJson(entry);
            const previousRelativePath = entry.relativePath;
            entry.relativePath = nextRelativePath;
            session.entryPathIndex.delete(previousRelativePath);
            this.ensureFolderAncestors(nextRelativePath);
            await this.saveEntry(entry, { previousRelativePath, previousEntrySnapshot });
          }

          const movedCount = entries.length + rootFolderMoves.length;
          this.pushLog(`moved ${movedCount} ${movedCount === 1 ? "item" : "items"} to ${normalizedDirectory || "archive root"}`);
          return {
            movedCount,
            selectedEntryId: entries[0]?.id || null
          };
        }
      });
      this.emitEntriesInvalidated({
        archiveId: this.requireArchiveSession().root.archiveId,
        reason: "bulk-move",
        selectedEntryId: result.selectedEntryId
      });
    } finally {
      this.endSessionOperation();
    }
  }

  async exportEntries(entryIds, variant, destination) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const uniqueIds = [...new Set(entryIds)];
      let exportedCount = 0;
      for (const entryId of uniqueIds) {
        const entry = await this.loadEntry(entryId);
        if (!entry) {
          throw new Error(`Entry not found: ${entryId}`);
        }
        const revision = entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId);
        if (!revision) {
          continue;
        }
        const descriptor =
          variant === "optimized" && revision.optimizedArtifact ? revision.optimizedArtifact : revision.originalArtifact;
        const safeName = entry.name.replace(path.extname(entry.name), "");
        const extension = descriptor.extension || path.extname(entry.name);
        const exportPath = path.join(destination, `${safeName}${variant === "optimized" ? "-optimized" : "-original"}${extension}`);
        await this.requireArchiveSession().objectStore.materializeObjectToFile(descriptor, exportPath);
        exportedCount += 1;
      }
      this.pushLog(`exported ${exportedCount} ${exportedCount === 1 ? "entry" : "entries"} to ${destination}`);
    } finally {
      this.endSessionOperation();
    }
  }
}

module.exports = {
  ArchiveService
};
