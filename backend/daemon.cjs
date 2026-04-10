const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { ArchiveService } = require("./archiveService");
const { collectDetectedArchives, createInitialState, sanitizeShellState } = require("./appState");
const { createInstallStatus, detectTooling, ensureRuntimeTools } = require("./tooling");

let state;
let archiveService;

function prependToProcessPath(paths) {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const existing = process.env.PATH || "";
  const prefix = paths.filter(Boolean).join(delimiter);
  if (!prefix) {
    return;
  }
  process.env.PATH = `${prefix}${delimiter}${existing}`;
}

process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") {
    process.exit(0);
    return;
  }
  throw error;
});

function parseUserDataPath(argv) {
  const index = argv.indexOf("--user-data-path");
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  return path.join(os.homedir(), ".stow");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendEvent(event, payload) {
  send({
    type: "event",
    event,
    payload
  });
}

function sendResponse(id, result, error) {
  const base = {
    type: "response",
    id,
    ok: !error
  };

  if (error) {
    send({ ...base, error });
    return;
  }

  send({ ...base, result });
}

function emitShellStateUpdate() {
  if (!state) {
    return;
  }

  sendEvent("app:shell-state-changed", sanitizeShellState(state));
}

function emitArchiveProgress(progress) {
  sendEvent("archive:progress", progress);
}

function emitEntriesInvalidated(payload) {
  sendEvent("archive:entries-invalidated", payload);
}

function appendToolingLogs(installResult) {
  if (!installResult.installed.length && !installResult.skipped.length) {
    return;
  }

  state.logs.push(...installResult.installed.map((message) => `tooling: ${message}`));
  state.logs.push(...installResult.skipped.map((message) => `tooling: ${message}`));
}

async function runRuntimeToolSetup() {
  const toolsDir = path.join(state.userDataPath, "tools");

  state.installStatus = createInstallStatus();
  emitShellStateUpdate();

  try {
    const installResult = await ensureRuntimeTools({
      toolsDir,
      enableUpscaling: state.settings?.upscaleEnabled !== false,
      onProgress: (installStatus) => {
        state.installStatus = installStatus;
        emitShellStateUpdate();
      }
    });

    state.capabilities = await detectTooling({ toolsDir });
    appendToolingLogs(installResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Automatic tooling install failed";
    state.installStatus = createInstallStatus({
      active: false,
      phase: "complete",
      message: "Tooling install failed",
      completedSteps: 1,
      skipped: [message]
    });
    state.logs.push(`tooling: ${message}`);
  }

  emitShellStateUpdate();
}

async function bootstrap() {
  const userDataPath = parseUserDataPath(process.argv);
  prependToProcessPath([path.join(userDataPath, "tools", "bin")]);
  state = await createInitialState(userDataPath, os.homedir());
  archiveService = new ArchiveService(state, {
    emitShellState: emitShellStateUpdate,
    emitProgress: emitArchiveProgress,
    emitEntriesInvalidated
  });
  await archiveService.initialize();
  emitShellStateUpdate();
  void runRuntimeToolSetup();
}

const backendReady = bootstrap();

async function ensureBackend() {
  await backendReady;
}

async function ensureInteractive() {
  await ensureBackend();
  if (state.installStatus.active) {
    throw new Error("Tooling setup is still running");
  }
}

async function handleCommand(method, payload) {
  switch (method) {
    case "app:get-shell-state":
      await ensureBackend();
      return sanitizeShellState(state);

    case "settings:save": {
      await ensureInteractive();
      const previousUpscaleEnabled = Boolean(state.settings?.upscaleEnabled);
      await archiveService.saveSettings(payload);
      emitShellStateUpdate();
      if (!previousUpscaleEnabled && state.settings?.upscaleEnabled) {
        await runRuntimeToolSetup();
      }
      return sanitizeShellState(state);
    }

    case "settings:reset": {
      await ensureInteractive();
      const previousUpscaleEnabled = Boolean(state.settings?.upscaleEnabled);
      await archiveService.resetSettings();
      emitShellStateUpdate();
      if (!previousUpscaleEnabled && state.settings?.upscaleEnabled) {
        await runRuntimeToolSetup();
      }
      return sanitizeShellState(state);
    }

    case "archive:create":
      await ensureInteractive();
      await archiveService.createArchive(payload);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:open":
      await ensureInteractive();
      await archiveService.openArchive(payload);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:close":
      await ensureInteractive();
      await archiveService.closeArchive();
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:lock":
      await ensureInteractive();
      await archiveService.lockArchive("manually locked archive session");
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:set-session-policy":
      await ensureInteractive();
      await archiveService.setArchiveSessionPolicy(payload || {});
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archives:remove":
      await ensureInteractive();
      await archiveService.removeRecentArchive(payload.archivePath);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archives:delete":
      await ensureInteractive();
      await archiveService.deleteArchive(payload.archivePath);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archives:list-detected":
      await ensureBackend();
      return collectDetectedArchives(state.homeDir);

    case "archive:add-paths":
      await ensureInteractive();
      {
        const result = await archiveService.addPaths(payload.paths || [], payload.manualClassifications || {});
        emitShellStateUpdate();
        return {
          shellState: sanitizeShellState(state),
          manualClassificationRequest: result?.manualClassificationRequest ?? null
        };
      }

    case "archive:reprocess-entry":
      await ensureInteractive();
      await archiveService.reprocessEntry(payload.entryId, payload.overrideMode);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:delete-entry":
      await ensureInteractive();
      await archiveService.deleteEntry(payload.entryId);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:rename-entry":
      await ensureInteractive();
      await archiveService.renameEntry(payload.entryId, payload.name);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:export-entry":
      await ensureInteractive();
      await archiveService.exportEntry(payload.entryId, payload.variant, payload.destination);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:open-entry-externally":
      await ensureInteractive();
      await archiveService.openEntryExternally(payload.entryId);
      emitShellStateUpdate();
      return sanitizeShellState(state);

    case "archive:resolve-entry-preview":
      await ensureInteractive();
      return archiveService.resolveEntryPreview(payload.entryId, payload.previewKind || "preview");

    case "archive:list-entries":
      await ensureInteractive();
      return archiveService.listEntries(payload || {});

    case "archive:get-entry-detail":
      await ensureInteractive();
      return archiveService.getEntryDetail(payload.entryId);

    case "archive:get-stats":
      await ensureInteractive();
      return archiveService.getStats();

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

let mutationQueue = Promise.resolve();

function isImmediateMethod(method) {
  return (
    method === "app:get-shell-state" ||
    method === "archives:list-detected" ||
    method === "archive:list-entries" ||
    method === "archive:get-entry-detail" ||
    method === "archive:get-stats" ||
    method === "archive:resolve-entry-preview"
  );
}

function handleRequest(request) {
  const id = request.id;
  if (typeof id !== "number" || typeof request.method !== "string") {
    return;
  }

  const run = async () => {
    try {
      const result = await handleCommand(request.method, request.params || {});
      sendResponse(id, result, null);
    } catch (error) {
      sendResponse(id, null, error instanceof Error ? error.message : "Unknown backend error");
    }
  };

  if (isImmediateMethod(request.method)) {
    void run();
    return;
  }

  mutationQueue = mutationQueue
    .then(run)
    .catch((error) => {
      sendEvent("daemon:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch (_error) {
    return;
  }

  handleRequest(request);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

process.on("SIGINT", () => {
  process.exit(0);
});
