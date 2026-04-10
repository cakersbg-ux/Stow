const fs = require("node:fs/promises");
const path = require("node:path");
const { createInstallStatus } = require("./tooling");

const DEFAULT_SETTINGS = {
  imageTargetResolution: "1440p",
  videoTargetResolution: "1080p",
  compressionBehavior: "balanced",
  optimizationMode: "visually_lossless",
  upscaleEnabled: true,
  stripDerivativeMetadata: true,
  deleteOriginalFilesAfterSuccessfulUpload: true,
  argonProfile: "balanced",
  preferredArchiveRoot: "",
  sessionIdleMinutes: 0,
  sessionLockOnHide: false
};
const SUPPORTED_MANIFEST_VERSION = 3;

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

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
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

async function collectDetectedArchives(rootPath, relativePrefix = "") {
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

    if (DETECTED_ARCHIVE_SKIP_DIRS.has(entry.name)) {
      continue;
    }

    if (entry.name.startsWith(".") && !entry.name.endsWith(".stow")) {
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
        lastModifiedAt: stat?.mtime?.toISOString() ?? new Date(0).toISOString(),
        sizeBytes: await collectDirectorySize(archivePath)
      });
      continue;
    }

    archives.push(...(await collectDetectedArchives(archivePath, relativePath)));
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

async function createInitialState(userDataPath, homeDir) {
  await ensureDir(userDataPath);
  const settingsPath = path.join(userDataPath, "settings.json");
  const defaultArchiveRoot = path.join(homeDir, "Stow Archives");
  await ensureDir(defaultArchiveRoot);
  const settings = {
    ...DEFAULT_SETTINGS,
    preferredArchiveRoot: defaultArchiveRoot,
    ...(await readJsonIfExists(settingsPath, {}))
  };

  return {
    userDataPath,
    homeDir,
    settingsPath,
    previewCachePath: path.join(userDataPath, "preview-cache"),
    upscaleRouterFeedbackPath: path.join(userDataPath, "upscale-router-feedback.jsonl"),
    upscaleRouterFeedbackSamplesPath: path.join(userDataPath, "upscale-router-feedback-samples"),
    runtimeTempPath: path.join(userDataPath, "runtime"),
    defaultArchiveRoot,
    settings,
    archiveSession: null,
    lockedArchive: null,
    archiveProgress: null,
    recentArchives: await collectArchivesWithinRoot(defaultArchiveRoot),
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
    session: session.session
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
  DEFAULT_SETTINGS,
  buildArchiveSummary,
  collectArchivesWithinRoot,
  collectDetectedArchives,
  createInitialState,
  sanitizeShellState
};
