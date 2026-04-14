const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteJson } = require("./atomicFile");
const { createInstallStatus } = require("./tooling");
const { DEFAULT_ARCHIVE_PREFERENCES, normalizeArchivePreferences } = require("./policies");

const DEFAULT_SETTINGS = {
  ...DEFAULT_ARCHIVE_PREFERENCES,
  deleteOriginalFilesAfterSuccessfulUpload: false,
  argonProfile: "balanced",
  preferredArchiveRoot: "",
  themePreference: "system",
  sessionIdleMinutes: 0,
  sessionLockOnHide: false,
  developerActivityLogEnabled: false
};
const SUPPORTED_MANIFEST_VERSION = 3;
const ARGON_PROFILES = new Set(["balanced", "strong", "constrained"]);
const THEME_PREFERENCES = new Set(["system", "light", "dark"]);
const DETECTED_ARCHIVES_CACHE_FILE = "detected-archives.json";
const DETECTED_ARCHIVES_CACHE_TTL_MS = 5 * 60 * 1000;

const DETECTED_ARCHIVE_SKIP_DIRS = new Set([
  ".cache",
  ".cargo",
  ".git",
  ".npm",
  ".pnpm",
  ".rustup",
  ".venv",
  ".yarn",
  "Applications",
  "AppData",
  "Caches",
  "build",
  "coverage",
  "dist",
  "Library",
  "node_modules",
  "private",
  "System",
  "target",
  "tmp",
  "venv"
]);

let detectedArchivesCache = null;

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function shouldSkipDetectedArchiveDirName(entryName) {
  if (DETECTED_ARCHIVE_SKIP_DIRS.has(entryName)) {
    return true;
  }

  return entryName.startsWith(".") && !entryName.endsWith(".stow");
}

function shouldSkipDetectedArchivePath(entryPath) {
  const cacheDir = detectedArchivesCache?.cachePath ? path.dirname(detectedArchivesCache.cachePath) : null;
  return Boolean(cacheDir && path.resolve(entryPath) === path.resolve(cacheDir));
}

async function collectDirectorySize(dirPath) {
  let total = 0;
  const stack = [dirPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(nextPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.stat(nextPath).catch(() => null);
      total += stat?.size ?? 0;
    }
  }

  return total;
}

async function snapshotDirectoryEntries(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (_error) {
    return null;
  }

  const snapshot = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (shouldSkipDetectedArchiveDirName(entry.name)) {
      continue;
    }

    const childPath = path.join(dirPath, entry.name);
    if (shouldSkipDetectedArchivePath(childPath)) {
      continue;
    }
    const stat = await fs.stat(childPath).catch(() => null);
    snapshot.push({
      name: entry.name,
      mtimeMs: stat?.mtimeMs ?? 0
    });
  }

  snapshot.sort((left, right) => left.name.localeCompare(right.name));
  return snapshot;
}

async function isSupportedArchiveVersion(archivePath) {
  const manifestPath = path.join(archivePath, "manifest.json");
  let manifestRaw;
  try {
    manifestRaw = await fs.readFile(manifestPath, "utf8");
  } catch (_error) {
    return false;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (_error) {
    return false;
  }

  const manifestVersion = typeof manifest.version === "number" && Number.isFinite(manifest.version) ? manifest.version : null;
  return manifestVersion === SUPPORTED_MANIFEST_VERSION;
}

function normalizeDetectedArchive(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const archivePath = typeof source.path === "string" ? source.path : "";
  const name = typeof source.name === "string" ? source.name : path.basename(archivePath, ".stow");
  const lastModifiedAt =
    typeof source.lastModifiedAt === "string" && Number.isFinite(Date.parse(source.lastModifiedAt))
      ? source.lastModifiedAt
      : new Date(0).toISOString();
  const sizeBytes = normalizeInteger(source.sizeBytes, 0, 0);

  if (!archivePath) {
    return null;
  }

  return {
    path: archivePath,
    name,
    lastModifiedAt,
    sizeBytes
  };
}

function normalizeDetectedArchives(entries) {
  const normalized = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const value = normalizeDetectedArchive(entry);
    if (value) {
      normalized.push(value);
    }
  }
  return normalized;
}

function cloneDetectedArchives(entries) {
  return normalizeDetectedArchives(entries).map((entry) => ({ ...entry }));
}

function normalizeDetectedArchivesCache(raw, homeDir, cachePath) {
  const source = raw && typeof raw === "object" ? raw : {};
  if (typeof source.homeDir !== "string" || source.homeDir !== homeDir) {
    return null;
  }

  const snapshot = Array.isArray(source.snapshot)
    ? source.snapshot
        .filter((entry) => entry && typeof entry === "object" && typeof entry.name === "string")
        .map((entry) => ({
          name: entry.name,
          mtimeMs: typeof entry.mtimeMs === "number" && Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0
        }))
    : [];
  snapshot.sort((left, right) => left.name.localeCompare(right.name));

  return {
    homeDir,
    cachePath,
    snapshot,
    scannedAt:
      typeof source.scannedAt === "string" && Number.isFinite(Date.parse(source.scannedAt))
        ? source.scannedAt
        : new Date(0).toISOString(),
    archives: normalizeDetectedArchives(source.archives)
  };
}

function getDetectedArchivesCacheFilePath(userDataPath) {
  return path.join(userDataPath, DETECTED_ARCHIVES_CACHE_FILE);
}

async function loadDetectedArchivesCache(cachePath, homeDir) {
  return normalizeDetectedArchivesCache(await readJsonIfExists(cachePath, null), homeDir, cachePath);
}

async function saveDetectedArchivesCache(cachePath, homeDir, snapshot, archives) {
  await atomicWriteJson(cachePath, {
    homeDir,
    scannedAt: new Date().toISOString(),
    snapshot,
    archives
  });
}

function shouldUseDetectedArchivesCache(rootPath, snapshot) {
  if (!detectedArchivesCache) {
    return false;
  }

  if (detectedArchivesCache.homeDir !== rootPath) {
    return false;
  }

  if (!Array.isArray(snapshot) || !Array.isArray(detectedArchivesCache.snapshot)) {
    return false;
  }

  if (Date.now() - Date.parse(detectedArchivesCache.scannedAt) > DETECTED_ARCHIVES_CACHE_TTL_MS) {
    return false;
  }

  if (snapshot.length !== detectedArchivesCache.snapshot.length) {
    return false;
  }

  const cachedByName = new Map(
    detectedArchivesCache.snapshot.map((entry) => [entry.name, entry.mtimeMs])
  );
  for (const current of snapshot) {
    if (!cachedByName.has(current.name) || cachedByName.get(current.name) !== current.mtimeMs) {
      return false;
    }
  }

  return true;
}

async function collectArchivesWithinRoot(rootPath, relativePrefix = "") {
  await ensureDir(rootPath);

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const archives = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const archivePath = path.join(rootPath, entry.name);
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;

    if (entry.name.endsWith(".stow")) {
      const supported = await isSupportedArchiveVersion(archivePath);
      if (!supported) {
        continue;
      }
      const stat = await fs.stat(archivePath).catch(() => null);
      archives.push({
        path: archivePath,
        name: relativePath.slice(0, -5),
        lastOpenedAt: stat?.mtime?.toISOString() ?? new Date(0).toISOString()
      });
      continue;
    }

    archives.push(...(await collectArchivesWithinRoot(archivePath, relativePath)));
  }

  return archives.sort((left, right) => left.name.localeCompare(right.name));
}

async function collectDetectedArchivesFromRoot(rootPath, relativePrefix = "") {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  const archives = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (shouldSkipDetectedArchiveDirName(entry.name)) {
      continue;
    }
    const archivePath = path.join(rootPath, entry.name);
    if (shouldSkipDetectedArchivePath(archivePath)) {
      continue;
    }
    const relativePath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;

    if (entry.name.endsWith(".stow")) {
      const supported = await isSupportedArchiveVersion(archivePath);
      if (!supported) {
        continue;
      }
      const stat = await fs.stat(archivePath).catch(() => null);
      archives.push({
        path: archivePath,
        name: relativePath.slice(0, -5),
        lastModifiedAt: stat?.mtime?.toISOString() ?? new Date(0).toISOString(),
        sizeBytes: await collectDirectorySize(archivePath)
      });
      continue;
    }

    archives.push(...(await collectDetectedArchivesFromRoot(archivePath, relativePath)));
  }

  return archives;
}

async function collectDetectedArchives(rootPath) {
  const snapshot = await snapshotDirectoryEntries(rootPath);
  if (shouldUseDetectedArchivesCache(rootPath, snapshot)) {
    return cloneDetectedArchives(detectedArchivesCache.archives);
  }

  const archives = await collectDetectedArchivesFromRoot(rootPath);
  detectedArchivesCache = {
    homeDir: rootPath,
    cachePath: detectedArchivesCache?.cachePath ?? null,
    snapshot: snapshot ?? [],
    scannedAt: new Date().toISOString(),
    archives: cloneDetectedArchives(archives)
  };

  if (detectedArchivesCache.cachePath) {
    await saveDetectedArchivesCache(
      detectedArchivesCache.cachePath,
      rootPath,
      detectedArchivesCache.snapshot,
      detectedArchivesCache.archives
    ).catch(() => {});
  }

  return archives;
}

async function readJsonIfExists(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeInteger(value, fallback, min = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.round(value));
}

function normalizeSettings(nextSettings, defaultArchiveRoot) {
  const source = nextSettings && typeof nextSettings === "object" ? nextSettings : {};
  const archivePreferences = normalizeArchivePreferences(source);
  return {
    ...archivePreferences,
    optimizationMode: archivePreferences.optimizationTier,
    deleteOriginalFilesAfterSuccessfulUpload: normalizeBoolean(
      source.deleteOriginalFilesAfterSuccessfulUpload,
      DEFAULT_SETTINGS.deleteOriginalFilesAfterSuccessfulUpload
    ),
    argonProfile: typeof source.argonProfile === "string" && ARGON_PROFILES.has(source.argonProfile) ? source.argonProfile : DEFAULT_SETTINGS.argonProfile,
    preferredArchiveRoot:
      typeof source.preferredArchiveRoot === "string" && source.preferredArchiveRoot.trim().length > 0
        ? source.preferredArchiveRoot
        : defaultArchiveRoot,
    themePreference:
      typeof source.themePreference === "string" && THEME_PREFERENCES.has(source.themePreference)
        ? source.themePreference
        : DEFAULT_SETTINGS.themePreference,
    sessionIdleMinutes: normalizeInteger(source.sessionIdleMinutes, DEFAULT_SETTINGS.sessionIdleMinutes, 0),
    sessionLockOnHide: normalizeBoolean(source.sessionLockOnHide, DEFAULT_SETTINGS.sessionLockOnHide),
    developerActivityLogEnabled: normalizeBoolean(
      source.developerActivityLogEnabled,
      DEFAULT_SETTINGS.developerActivityLogEnabled
    )
  };
}

function normalizeRecentArchive(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const archivePath = typeof source.path === "string" ? source.path : "";
  const name = typeof source.name === "string" ? source.name : path.basename(archivePath, ".stow");
  const lastOpenedAt =
    typeof source.lastOpenedAt === "string" && Number.isFinite(Date.parse(source.lastOpenedAt))
      ? source.lastOpenedAt
      : new Date(0).toISOString();

  if (!archivePath) {
    return null;
  }

  return {
    path: archivePath,
    name,
    lastOpenedAt
  };
}

function normalizeRecentArchives(entries) {
  const byPath = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeRecentArchive(entry);
    if (!normalized) {
      continue;
    }

    const current = byPath.get(normalized.path);
    if (!current || Date.parse(normalized.lastOpenedAt) > Date.parse(current.lastOpenedAt)) {
      byPath.set(normalized.path, normalized);
    }
  }

  return [...byPath.values()].sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt));
}

async function loadRecentArchives(recentArchivesPath) {
  const entries = normalizeRecentArchives(await readJsonIfExists(recentArchivesPath, []));
  const available = [];

  for (const entry of entries) {
    if (!(await exists(entry.path))) {
      continue;
    }
    if (!(await isSupportedArchiveVersion(entry.path))) {
      continue;
    }
    available.push(entry);
  }

  return available;
}

async function saveRecentArchives(recentArchivesPath, recentArchives) {
  await atomicWriteJson(recentArchivesPath, normalizeRecentArchives(recentArchives));
}

async function createInitialState(userDataPath, homeDir) {
  await ensureDir(userDataPath);
  const settingsPath = path.join(userDataPath, "settings.json");
  const recentArchivesPath = path.join(userDataPath, "recent-archives.json");
  const detectedArchivesPath = getDetectedArchivesCacheFilePath(userDataPath);
  const defaultArchiveRoot = path.join(homeDir, "Stow Archives");
  await ensureDir(defaultArchiveRoot);
  const settings = normalizeSettings(
    {
      ...DEFAULT_SETTINGS,
      preferredArchiveRoot: defaultArchiveRoot,
      ...(await readJsonIfExists(settingsPath, {}))
    },
    defaultArchiveRoot
  );
  await ensureDir(settings.preferredArchiveRoot);
  detectedArchivesCache = await loadDetectedArchivesCache(detectedArchivesPath, homeDir);
  if (!detectedArchivesCache) {
    detectedArchivesCache = {
      homeDir,
      cachePath: detectedArchivesPath,
      snapshot: [],
      scannedAt: new Date(0).toISOString(),
      archives: []
    };
  } else {
    detectedArchivesCache.cachePath = detectedArchivesPath;
  }

  return {
    userDataPath,
    homeDir,
    settingsPath,
    recentArchivesPath,
    previewCachePath: path.join(userDataPath, "preview-cache"),
    runtimeTempPath: path.join(userDataPath, "runtime"),
    defaultArchiveRoot,
    settings,
    archiveSession: null,
    lockedArchive: null,
    archiveProgress: null,
    recentArchives: await loadRecentArchives(recentArchivesPath),
    capabilities: {},
    installStatus: createInstallStatus(),
    logs: []
  };
}

function buildArchiveSummary(session) {
  if (!session) {
    return null;
  }

  return {
    archiveId: session.root.archiveId,
    name: session.root.name,
    path: session.path,
    unlocked: true,
    entryCount: session.root.stats.entryCount,
    storedObjectCount: session.root.stats.storedObjectCount,
    logicalBytes: session.root.stats.logicalBytes,
    storedBytes: session.root.stats.storedBytes,
    updatedAt: session.root.updatedAt,
    preferences: normalizeArchivePreferences(session.root.preferences),
    session: session.session,
    folders: Array.isArray(session.root.folders) ? session.root.folders : []
  };
}

function sanitizeShellState(state) {
  if (state.archiveSession) {
    return {
      settings: state.settings,
      hasConfiguredDefaults: Boolean(state.settings),
      capabilities: state.capabilities,
      installStatus: state.installStatus,
      recentArchives: state.recentArchives,
      archive: {
        path: state.archiveSession.path,
        unlocked: true,
        summary: buildArchiveSummary(state.archiveSession),
        session: state.archiveSession.session
      },
      logs: state.archiveSession.root.logs.slice(-200)
    };
  }

  if (state.lockedArchive) {
    return {
      settings: state.settings,
      hasConfiguredDefaults: Boolean(state.settings),
      capabilities: state.capabilities,
      installStatus: state.installStatus,
      recentArchives: state.recentArchives,
      archive: {
        path: state.lockedArchive.path,
        unlocked: false,
        summary: null,
        session: null
      },
      logs: state.logs.slice(-200)
    };
  }

  return {
    settings: state.settings,
    hasConfiguredDefaults: Boolean(state.settings),
    capabilities: state.capabilities,
    installStatus: state.installStatus,
    recentArchives: state.recentArchives,
    archive: null,
    logs: state.logs.slice(-200)
  };
}

module.exports = {
  DEFAULT_ARCHIVE_PREFERENCES,
  DEFAULT_SETTINGS,
  buildArchiveSummary,
  collectArchivesWithinRoot,
  collectDetectedArchives,
  collectDetectedArchivesFromRoot,
  createInitialState,
  loadRecentArchives,
  normalizeArchivePreferences,
  normalizeRecentArchives,
  normalizeSettings,
  saveRecentArchives,
  sanitizeShellState
};
