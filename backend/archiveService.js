const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { v4: uuid } = require("uuid");
const mime = require("mime-types");
const { createArchiveEncryption, unlockArchiveKey } = require("./crypto");
const { DEFAULT_SETTINGS, collectArchivesWithinRoot, normalizeSettings } = require("./appState");
const {
  createArchiveCatalog,
  deleteEntryCatalog,
  loadArchiveCatalog,
  readEntryCatalog,
  saveRootCatalog,
  writeEntryCatalog
} = require("./catalogStore");
const { UPSCALE_ROUTES, analyzePath, classifyPath, generatePreviewFile, inspectManualRoutingRequirement } = require("./mediaTools");
const { ObjectStore } = require("./objectStore");
const { PreviewCache } = require("./previewCache");

const SESSION_IDLE_MINUTES_DEFAULT = 0;
const SESSION_IDLE_MINUTES_MAX = 24 * 60;
const OPEN_TEMP_DIRNAME = "open-files";
const PREVIEW_KINDS = ["thumbnail", "preview"];

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function isDirectory(dirPath) {
  const stat = await fs.stat(dirPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function appendJsonLine(filePath, value) {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function* walkInputPath(inputPath, relativePrefix = path.basename(inputPath)) {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    yield {
      absolutePath: inputPath,
      relativePath: relativePrefix,
      size: stat.size
    };
    return;
  }

  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  for (const entry of entries) {
    const absoluteChild = path.join(inputPath, entry.name);
    const childRelative = path.join(relativePrefix, entry.name);
    if (entry.isDirectory()) {
      yield* walkInputPath(absoluteChild, childRelative);
    } else if (entry.isFile()) {
      const childStat = await fs.stat(absoluteChild);
      yield {
        absolutePath: absoluteChild,
        relativePath: childRelative,
        size: childStat.size
      };
    }
  }
}

async function* iterateInputFiles(inputPaths) {
  for (const inputPath of inputPaths) {
    yield* walkInputPath(inputPath);
  }
}

async function collectInputFiles(inputPaths) {
  const files = [];
  for await (const file of iterateInputFiles(inputPaths)) {
    files.push(file);
  }
  return files;
}

function normalizeIdleMinutes(value, fallback) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  if (rounded <= 0) {
    return 0;
  }
  return Math.min(SESSION_IDLE_MINUTES_MAX, rounded);
}

function normalizeSessionPolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  const hasIdleMinutes = Object.prototype.hasOwnProperty.call(source, "idleMinutes");
  const hasLockOnHide = Object.prototype.hasOwnProperty.call(source, "lockOnHide");

  return {
    idleMinutes: hasIdleMinutes ? normalizeIdleMinutes(source.idleMinutes, null) : null,
    lockOnHide: hasLockOnHide && typeof source.lockOnHide === "boolean" ? source.lockOnHide : null
  };
}

function getGlobalSessionDefaults(settings) {
  return {
    idleMinutes: normalizeIdleMinutes(settings?.sessionIdleMinutes, SESSION_IDLE_MINUTES_DEFAULT) ?? SESSION_IDLE_MINUTES_DEFAULT,
    lockOnHide: typeof settings?.sessionLockOnHide === "boolean" ? settings.sessionLockOnHide : false
  };
}

function resolveEffectiveSessionPolicy(settings, archivePolicy) {
  const globalDefaults = getGlobalSessionDefaults(settings);
  return {
    idleMinutes: archivePolicy.idleMinutes ?? globalDefaults.idleMinutes,
    lockOnHide: archivePolicy.lockOnHide ?? globalDefaults.lockOnHide
  };
}

function computeSessionExpiry(lastActivityAt, idleMinutes) {
  if (idleMinutes <= 0) {
    return null;
  }
  return new Date(new Date(lastActivityAt).getTime() + idleMinutes * 60 * 1000).toISOString();
}

async function withTempDir(prefix, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnOpenFile(filePath) {
  return new Promise((resolve, reject) => {
    let command;
    let args;

    if (process.platform === "darwin") {
      command = "open";
      args = [filePath];
    } else if (process.platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", filePath];
    } else {
      command = "xdg-open";
      args = [filePath];
    }

    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function entryFileName(entry, descriptor) {
  const baseName = entry.name.replace(path.extname(entry.name), "");
  const extension = descriptor.extension || path.extname(entry.name) || (mime.extension(descriptor.mime || "") ? `.${mime.extension(descriptor.mime)}` : "");
  return `${baseName}${extension}`;
}

function validateEntryRename(nextName) {
  const normalizedName = typeof nextName === "string" ? nextName.trim() : "";
  if (!normalizedName) {
    throw new Error("File name is required");
  }
  if (normalizedName === "." || normalizedName === "..") {
    throw new Error("File name is invalid");
  }
  if (normalizedName.includes("/") || normalizedName.includes("\\")) {
    throw new Error("File name cannot include path separators");
  }
  return normalizedName;
}

function buildLightweightEntry(entry) {
  const latestRevision = entry.revisions.find((candidate) => candidate.id === entry.latestRevisionId) ?? entry.revisions[0] ?? null;
  return {
    id: entry.id,
    name: entry.name,
    relativePath: entry.relativePath,
    fileKind: entry.fileKind,
    mime: entry.mime,
    size: entry.size,
    latestRevisionId: entry.latestRevisionId,
    overrideMode: latestRevision?.overrideMode ?? null,
    previewable: entry.fileKind === "image" || entry.fileKind === "video"
  };
}

function buildEntryDetail(entry) {
  return {
    ...entry,
    exportableVariants: {
      original: true,
      optimized: Boolean(entry.revisions[0]?.optimizedArtifact)
    }
  };
}

function buildManualRoutingRequestItem(file, requirement) {
  return {
    absolutePath: file.absolutePath,
    relativePath: file.relativePath,
    mediaType: requirement.mediaType,
    failureCode: requirement.failureCode,
    reason: requirement.message,
    suggestedRoute: requirement.suggestedRoute ?? null,
    choices: UPSCALE_ROUTES
  };
}

class ArchiveService {
  constructor(state, emitters) {
    this.state = state;
    this.emitShellState = emitters.emitShellState;
    this.emitProgress = emitters.emitProgress;
    this.emitEntriesInvalidated = emitters.emitEntriesInvalidated;
    this.autoLockTimer = null;
    this.activeSessionOperations = 0;
    this.previewCache = new PreviewCache({
      baseDir: this.state.previewCachePath
    });
  }

  async initialize() {
    await ensureDir(this.state.runtimeTempPath);
    await this.previewCache.initialize();
    await ensureDir(this.state.upscaleRouterFeedbackSamplesPath);
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
        const preview = await generatePreviewFile(sourcePath, fileKind, kind, outputDir);
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
      await this.previewCache.deletePreviewDir(this.previewKey(entry.id, revision.id, "preview"));
    }
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

  async recordManualRouteFeedback(files, manualRoutes) {
    if (!this.state.upscaleRouterFeedbackPath || !this.state.upscaleRouterFeedbackSamplesPath) {
      return;
    }

    const selectedFiles = files.filter((file) => manualRoutes[file.absolutePath]);
    if (!selectedFiles.length) {
      return;
    }

    for (const file of selectedFiles) {
      const route = manualRoutes[file.absolutePath];
      const mediaType = classifyPath(file.absolutePath);
      if (mediaType !== "image" && mediaType !== "video") {
        continue;
      }

      try {
        const sampleId = uuid();
        const sampleDir = path.join(this.state.upscaleRouterFeedbackSamplesPath, sampleId);
        await ensureDir(sampleDir);
        const preview = await generatePreviewFile(file.absolutePath, mediaType, "preview", sampleDir);
        if (!preview?.path) {
          continue;
        }

        await appendJsonLine(this.state.upscaleRouterFeedbackPath, {
          recordedAt: new Date().toISOString(),
          sourcePath: file.absolutePath,
          relativePath: file.relativePath,
          mediaType,
          route,
          samplePath: preview.path,
          sampleMime: preview.mime
        });
      } catch (error) {
        this.pushLog(`failed to record upscale router feedback for ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
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

  async cleanupOpenTempArtifacts() {
    await fs.rm(path.join(this.state.runtimeTempPath, OPEN_TEMP_DIRNAME), {
      recursive: true,
      force: true
    }).catch(() => {});
    await ensureDir(path.join(this.state.runtimeTempPath, OPEN_TEMP_DIRNAME));
  }

  async disposeArchiveSession({ preserveLockedArchive = false } = {}) {
    this.clearAutoLockTimer();
    this.activeSessionOperations = 0;
    if (this.state.archiveSession) {
      this.wipeArchiveKey(this.state.archiveSession.archiveKey);
    }
    this.state.archiveProgress = null;
    this.state.archiveSession = null;
    if (!preserveLockedArchive) {
      this.state.lockedArchive = null;
    }
    await this.cleanupOpenTempArtifacts();
    void this.previewCache.cleanup();
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
      root,
      session: null,
      entryCache: new Map()
    };
    session.objectStore = new ObjectStore(session, this.state.capabilities);
    return session;
  }

  async persistRoot() {
    const session = this.requireArchiveSession();
    session.root.updatedAt = new Date().toISOString();
    await saveRootCatalog(session.path, session.manifestEnvelope, session.archiveKey, session.root);
  }

  async loadEntry(entryId) {
    const session = this.requireArchiveSession();
    if (!session.entryCache.has(entryId)) {
      const entry = await readEntryCatalog(session.path, session.archiveKey, entryId);
      session.entryCache.set(entryId, entry);
    }
    return session.entryCache.get(entryId);
  }

  async saveEntry(entry) {
    const session = this.requireArchiveSession();
    session.entryCache.set(entry.id, entry);
    await writeEntryCatalog(session.path, session.archiveKey, entry);
  }

  async deleteEntry(entryId) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }

      session.root.entryOrder = session.root.entryOrder.filter((candidate) => candidate !== entryId);
      session.root.stats.entryCount = Math.max(0, session.root.stats.entryCount - 1);
      session.root.stats.logicalBytes = Math.max(0, session.root.stats.logicalBytes - entry.size);
      await this.deleteEntryPreviewArtifacts(entry);
      await session.objectStore.releaseEntry(entry);
      session.entryCache.delete(entryId);
      await deleteEntryCatalog(session.path, entryId);
      this.pushLog(`deleted ${entry.relativePath} from archive`);
      await this.persistRoot();
      this.emitEntriesInvalidated({
        archiveId: session.root.archiveId,
        reason: "delete",
        selectedEntryId: session.root.entryOrder[0] || null
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
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }

      const normalizedName = validateEntryRename(nextName);
      if (normalizedName === entry.name) {
        return;
      }

      const parentPath = path.dirname(entry.relativePath);
      const nextRelativePath = parentPath === "." ? normalizedName : path.join(parentPath, normalizedName);

      for (const candidateId of session.root.entryOrder) {
        if (candidateId === entryId) {
          continue;
        }
        const candidate = await this.loadEntry(candidateId);
        if (candidate?.relativePath === nextRelativePath) {
          throw new Error("An entry with that name already exists in this folder");
        }
      }

      const previousRelativePath = entry.relativePath;
      entry.name = normalizedName;
      entry.relativePath = nextRelativePath;
      await this.saveEntry(entry);
      this.pushLog(`renamed ${previousRelativePath} to ${nextRelativePath}`);
      await this.persistRoot();
      this.emitEntriesInvalidated({
        archiveId: session.root.archiveId,
        reason: "rename",
        selectedEntryId: entry.id
      });
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

  async refreshDefaultArchives() {
    this.state.recentArchives = await collectArchivesWithinRoot(this.state.defaultArchiveRoot);
  }

  async removeRecentArchive() {
    await this.refreshDefaultArchives();
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

    if (currentArchivePath === targetPath || lockedArchivePath === targetPath) {
      await this.disposeArchiveSession();
    }

    await fs.rm(targetPath, { recursive: true, force: true });
    await this.refreshDefaultArchives();
    this.pushLog(`deleted archive at ${targetPath}`);
  }

  async createArchive({ parentPath, name, password, preferences }) {
    const archivePath = path.join(parentPath, `${name}.stow`);
    if (await exists(archivePath)) {
      throw new Error("Archive path already exists");
    }

    await ensureDir(archivePath);
    const mergedPreferences = normalizeSettings(
      {
        ...this.state.settings,
        ...preferences
      },
      this.state.defaultArchiveRoot
    );
    const encryption = await createArchiveEncryption(password, mergedPreferences.argonProfile);
    const { manifestEnvelope, root } = await createArchiveCatalog({
      archivePath,
      encryptionHeader: {
        ...encryption.header,
        profile: mergedPreferences.argonProfile
      },
      archiveKey: encryption.archiveKey,
      name,
      preferences: mergedPreferences
    });

    await this.disposeArchiveSession();
    this.state.archiveSession = this.createSession(
      archivePath,
      encryption.archiveKey,
      manifestEnvelope.encryption,
      manifestEnvelope,
      root
    );
    this.initializeArchiveSessionTimer();
    await this.refreshDefaultArchives();
    this.pushLog(`created archive at ${archivePath}`);
    await this.persistRoot();
  }

  async openArchive({ archivePath, password }) {
    const manifest = await fs.readFile(path.join(archivePath, "manifest.json"), "utf8").catch(() => null);
    if (!manifest) {
      throw new Error("Archive manifest not found");
    }

    const manifestEnvelope = JSON.parse(manifest);
    if (manifestEnvelope.version !== 3) {
      throw new Error(`Unsupported archive version ${manifestEnvelope.version ?? "unknown"}. Stow vNext only opens v3 archives.`);
    }

    const archiveKey = await unlockArchiveKey(password, manifestEnvelope.encryption);
    const { root } = await loadArchiveCatalog(archivePath, archiveKey);

    await this.disposeArchiveSession();
    this.state.archiveSession = this.createSession(
      archivePath,
      archiveKey,
      manifestEnvelope.encryption,
      manifestEnvelope,
      root
    );
    this.initializeArchiveSessionTimer();
    await this.refreshDefaultArchives();
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

  async addPaths(paths, manualRoutes = {}) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      let completedFiles = 0;
      let ingestedAny = false;
      const uploadedSourcePaths = new Set();
      const normalizedManualRoutes = manualRoutes && typeof manualRoutes === "object" ? manualRoutes : {};
      const inputFiles = await collectInputFiles(paths);
      await this.recordManualRouteFeedback(inputFiles, normalizedManualRoutes);

      const ingestResult = await withTempDir("stow-ingest-", async (tempDir) => {
        this.emitProgress({
          active: true,
          phase: "preparing",
          currentFile: null,
          completedFiles: 0,
          totalFiles: null
        });

        const manualRoutingItems = [];
        for (const file of inputFiles) {
          const requirement = await inspectManualRoutingRequirement(
            file.absolutePath,
            session.root.preferences,
            this.state.capabilities,
            tempDir,
            normalizedManualRoutes[file.absolutePath] ?? null
          );
          if (requirement) {
            manualRoutingItems.push(buildManualRoutingRequestItem(file, requirement));
          }
        }

        if (manualRoutingItems.length) {
          this.emitProgress({
            active: false,
            phase: "processing",
            currentFile: null,
            completedFiles: 0,
            totalFiles: inputFiles.length
          });
          return {
            manualRoutingRequest: {
              items: manualRoutingItems
            }
          };
        }

        for (const file of inputFiles) {
          ingestedAny = true;
          uploadedSourcePaths.add(file.absolutePath);
          this.emitProgress({
            active: true,
            phase: "processing",
            currentFile: file.relativePath,
            completedFiles,
            totalFiles: null
          });
          this.touchArchiveSession();
          await this.ingestSource({
            absolutePath: file.absolutePath,
            relativePath: file.relativePath,
            tempDir,
            existingEntryId: null,
            overrideMode: null,
            manualRoute: normalizedManualRoutes[file.absolutePath] ?? null
          });
          completedFiles += 1;
        }

        return {
          manualRoutingRequest: null
        };
      });

      this.emitProgress({
        active: false,
        phase: "processing",
        currentFile: null,
        completedFiles,
        totalFiles: completedFiles
      });

      if (ingestResult?.manualRoutingRequest) {
        return ingestResult;
      }

      if (!ingestedAny) {
        return {
          manualRoutingRequest: null
        };
      }

      await this.persistRoot();
      if (this.state.settings.deleteOriginalFilesAfterSuccessfulUpload) {
        await this.deleteUploadedSourceFiles([...uploadedSourcePaths]);
      }
      this.emitEntriesInvalidated({
        archiveId: session.root.archiveId,
        reason: "ingest",
        selectedEntryId: session.root.entryOrder[0] || null
      });
      return {
        manualRoutingRequest: null
      };
    } finally {
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

  async ingestSource({ absolutePath, relativePath, tempDir, existingEntryId, overrideMode, manualRoute = null }) {
    const session = this.requireArchiveSession();
    const entryId = existingEntryId || uuid();
    const preferences = {
      ...session.root.preferences,
      ...(overrideMode ? { optimizationMode: overrideMode } : {})
    };
    const analysis = await analyzePath(absolutePath, preferences, this.state.capabilities, tempDir, {
      manualRoute
    });
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
        absolutePath,
        relativePath,
        size: stats.size
      },
      media: {
        width: analysis.original.width || null,
        height: analysis.original.height || null,
        codec: analysis.original.codec || null
      },
      overrideMode: overrideMode || null,
      routing: analysis.routing ?? null,
      summary: analysis.summary,
      actions: [
        overrideMode ? `per-file override ${overrideMode}` : "used archive defaults",
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

    if (existingEntryId) {
      const existingEntry = await this.loadEntry(existingEntryId);
      session.root.stats.logicalBytes += stats.size - existingEntry.size;
      existingEntry.latestRevisionId = revisionId;
      existingEntry.size = stats.size;
      existingEntry.mime = analysis.original.mime;
      existingEntry.fileKind = analysis.kind;
      existingEntry.revisions.unshift(nextRevision);
      await this.saveEntry(existingEntry);
      await this.cacheRevisionPreviews(existingEntry.id, revisionId, analysis.kind, analysis.previewSourcePath || analysis.original.path);
      this.pushLog(`reprocessed ${relativePath} with override ${overrideMode}`);
      return existingEntry.id;
    }

    const entry = {
      id: entryId,
      name: path.basename(absolutePath),
      relativePath,
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
    this.pushLog(`ingested ${relativePath} (${analysis.kind})`);
    return entryId;
  }

  async listEntries({ offset = 0, limit = 100 }) {
    const session = this.requireArchiveSession();
    const ids = session.root.entryOrder.slice(offset, offset + limit);
    const items = [];
    for (const entryId of ids) {
      const entry = await this.loadEntry(entryId);
      items.push(buildLightweightEntry(entry));
    }
    return {
      total: session.root.entryOrder.length,
      items
    };
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
      if (!["image", "video"].includes(classifyPath(entry.name)) && !["image", "video"].includes(entry.fileKind)) {
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
          entry.fileKind === "video" && revision.optimizedArtifact ? revision.optimizedArtifact : revision.originalArtifact;
        const sourcePath = await session.objectStore.materializeObjectToTempPath(
          previewArtifact,
          previewArtifact.extension || path.extname(entry.name),
          "stow-preview-materialized-"
        );
        try {
          const outputDir = this.previewCache.previewDir(key);
          await ensureDir(outputDir);
          const preview = await generatePreviewFile(sourcePath, entry.fileKind, previewKind, outputDir);
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

  async reprocessEntry(entryId, overrideMode, routeOverride = null) {
    this.requireArchiveSession();
    this.beginSessionOperation();
    try {
      const session = this.requireArchiveSession();
      const entry = await this.loadEntry(entryId);
      if (!entry) {
        throw new Error("Entry not found");
      }
      const sourcePath = entry.revisions[0]?.source?.absolutePath;
      if (!sourcePath || !(await exists(sourcePath))) {
        throw new Error("Original source path is not available for reprocessing");
      }
      if (routeOverride) {
        await this.recordManualRouteFeedback(
          [
            {
              absolutePath: sourcePath,
              relativePath: entry.relativePath,
              size: entry.size
            }
          ],
          { [sourcePath]: routeOverride }
        );
      }

      await withTempDir("stow-reprocess-", async (tempDir) => {
        await this.ingestSource({
          absolutePath: sourcePath,
          relativePath: entry.relativePath,
          tempDir,
          existingEntryId: entry.id,
          overrideMode,
          manualRoute: routeOverride
        });
      });
      await this.persistRoot();
      this.emitEntriesInvalidated({
        archiveId: session.root.archiveId,
        reason: "reprocess",
        selectedEntryId: entry.id
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
}

module.exports = {
  ArchiveService
};
