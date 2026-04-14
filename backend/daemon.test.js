const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { resolveDetectedArchiveScanRoot } = require("./daemon.cjs");

async function withTempDir(prefix, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createToolingPreloadScript() {
  const preloadDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-daemon-preload-"));
  const preloadPath = path.join(preloadDir, "preload.cjs");
  const daemonPath = path.resolve(__dirname, "daemon.cjs");
  const script = `
const Module = require("node:module");
const originalLoad = Module._load;
let detectCalls = 0;

function createCapabilities(available) {
  return {
    zstd: { available, version: available ? "zstd 1.5.7" : null, path: available ? "/opt/stow/tools/bin/zstd" : null },
    cjxl: { available, version: available ? "cjxl 0.11.2" : null, path: available ? "/opt/stow/tools/bin/cjxl" : null },
    djxl: { available: false, version: null, path: null },
    lzma2Offline: { available: false, version: null, path: null, reason: "7z not detected" },
    ffmpeg: { available: false, version: null, path: null },
    ffprobe: { available: false, path: null },
    av1Encoder: { available: false, value: null }
  };
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./tooling" && parent && parent.filename === ${JSON.stringify(daemonPath)}) {
    return {
      createInstallStatus(overrides = {}) {
        return {
          active: true,
          phase: "checking",
          message: "Checking local tooling",
          currentTarget: null,
          completedSteps: 0,
          totalSteps: 1,
          installed: [],
          skipped: [],
          ...overrides
        };
      },
      detectTooling: async () => {
        detectCalls += 1;
        return detectCalls === 1 ? createCapabilities(false) : createCapabilities(true);
      },
      installMissingRuntimeTools: async ({ onProgress } = {}) => {
        const installing = {
          active: true,
          phase: "installing",
          message: "Installing local tooling",
          currentTarget: "zstd",
          completedSteps: 0,
          totalSteps: 2,
          installed: [],
          skipped: []
        };
        if (typeof onProgress === "function") {
          onProgress(installing);
          onProgress({
            ...installing,
            active: false,
            phase: "complete",
            message: "Local tooling install finished",
            currentTarget: null,
            completedSteps: 2,
            installed: ["zstd via managed installer"],
            skipped: ["cjxl via managed installer"]
          });
        }
        return {
          attempted: true,
          installed: ["zstd via managed installer"],
          skipped: ["cjxl via managed installer"]
        };
      }
    };
  }
  return originalLoad.apply(this, arguments);
};
`;

  await fs.writeFile(preloadPath, script, "utf8");
  return {
    preloadPath,
    cleanup: async () => {
      await fs.rm(preloadDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function spawnDaemon({ homeDir, userDataDir, preloadPath = null }) {
  const daemonPath = path.resolve(__dirname, "daemon.cjs");
  const env = { ...process.env };

  if (process.platform === "win32") {
    env.USERPROFILE = homeDir;
    env.HOME = homeDir;
  } else {
    env.HOME = homeDir;
  }

  const args = [];
  if (preloadPath) {
    args.push("-r", preloadPath);
  }
  args.push(daemonPath, "--user-data-path", userDataDir);

  const child = spawn(process.execPath, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const bus = new EventEmitter();
  const pending = new Map();
  const seenEvents = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          if (message.type === "response") {
            const entry = pending.get(message.id);
            if (entry) {
              pending.delete(message.id);
              clearTimeout(entry.timeout);
              if (message.ok) {
                entry.resolve(message.result);
              } else {
                entry.reject(new Error(message.error || "Backend command failed"));
              }
            }
          } else if (message.type === "event" && typeof message.event === "string") {
            const event = { name: message.event, payload: message.payload };
            seenEvents.push(event);
            bus.emit(`event:${message.event}`, message.payload);
          }
        } catch (_error) {
          // Ignore non-JSON output.
        }
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `timed out waiting for response to ${method}; stderr was:\n${stderrBuffer.trim()}`
          )
        );
      }, 30_000);

      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  function waitForEvent(name, predicate = () => true) {
    const existing = seenEvents.find((event) => event.name === name && predicate(event.payload));
    if (existing) {
      return Promise.resolve(existing.payload);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bus.removeListener(`event:${name}`, listener);
        reject(
          new Error(
            `timed out waiting for event ${name}; stderr was:\n${stderrBuffer.trim()}`
          )
        );
      }, 30_000);

      const listener = (payload) => {
        if (!predicate(payload)) {
          return;
        }
        clearTimeout(timeout);
        bus.removeListener(`event:${name}`, listener);
        resolve(payload);
      };

      bus.on(`event:${name}`, listener);
    });
  }

  return {
    child,
    request,
    waitForEvent,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      await new Promise((resolve) => {
        child.once("exit", resolve);
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }).catch(() => {});
    }
  };
}

test("detected archive scans prefer the configured archive root", () => {
  assert.equal(
    resolveDetectedArchiveScanRoot({
      settings: {
        preferredArchiveRoot: "/Users/example/Archives"
      },
      defaultArchiveRoot: "/Users/example/Stow Archives",
      homeDir: "/Users/example"
    }),
    "/Users/example/Archives"
  );
});

test("detected archive scans fall back to the default archive root before homeDir", () => {
  assert.equal(
    resolveDetectedArchiveScanRoot({
      settings: {},
      defaultArchiveRoot: "/Users/example/Stow Archives",
      homeDir: "/Users/example"
    }),
    "/Users/example/Stow Archives"
  );
});

test("explicit runtime-tool install updates shell state after a manual install request", async () => {
  await withTempDir("stow-daemon-home-", async (homeDir) => {
    await withTempDir("stow-daemon-user-data-", async (userDataDir) => {
      const { preloadPath, cleanup } = await createToolingPreloadScript();
      const daemon = spawnDaemon({ homeDir, userDataDir, preloadPath });

      try {
        const bootState = await daemon.waitForEvent(
          "app:shell-state-changed",
          (payload) => payload.installStatus?.active === false && payload.installStatus?.phase === "complete"
        );
        assert.equal(bootState.capabilities.zstd.available, false);

        const installState = await daemon.request("runtime:install-missing-tools");
        assert.equal(installState.capabilities.zstd.available, true);
        assert.equal(installState.capabilities.cjxl.available, true);
        assert.equal(installState.installStatus.active, false);
        assert.equal(installState.installStatus.phase, "complete");
        assert.equal(installState.installStatus.message, "Local tooling install finished");
        assert.ok(installState.installStatus.installed.some((message) => message.includes("zstd")));
        assert.ok(installState.installStatus.skipped.some((message) => message.includes("cjxl")));

        const updatedState = await daemon.waitForEvent(
          "app:shell-state-changed",
          (payload) => payload.capabilities?.zstd?.available === true && payload.installStatus?.message === "Local tooling install finished"
        );
        assert.equal(updatedState.capabilities.zstd.available, true);
        assert.equal(updatedState.capabilities.cjxl.available, true);
        assert.equal(updatedState.installStatus.message, "Local tooling install finished");
      } finally {
        await daemon.stop();
        await cleanup();
      }
    });
  });
});
