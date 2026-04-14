const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

async function withTempDir(prefix, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createSupportedArchive(archivePath) {
  await fs.mkdir(archivePath, { recursive: true });
  await fs.writeFile(path.join(archivePath, "manifest.json"), JSON.stringify({ version: 3 }));
  await fs.writeFile(path.join(archivePath, "sample.txt"), "data");
}

function spawnDaemon({ homeDir, userDataDir }) {
  const daemonPath = path.resolve(__dirname, "daemon.cjs");
  const env = { ...process.env };

  if (process.platform === "win32") {
    env.USERPROFILE = homeDir;
    env.HOME = homeDir;
  } else {
    env.HOME = homeDir;
  }

  const child = spawn(process.execPath, [daemonPath, "--user-data-path", userDataDir], {
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

test("daemon boots, emits shell state, and serves detected archives over JSON-RPC", async () => {
  await withTempDir("stow-daemon-home-", async (homeDir) => {
    await withTempDir("stow-daemon-user-data-", async (userDataDir) => {
      const archiveRoot = path.join(homeDir, "Stow Archives");
      const archivePath = path.join(archiveRoot, "demo.stow");
      await createSupportedArchive(archivePath);

      const daemon = spawnDaemon({ homeDir, userDataDir });
      try {
        const initialShellState = await daemon.waitForEvent("app:shell-state-changed");
        assert.ok(initialShellState.installStatus);
        assert.ok(initialShellState.settings);
        assert.equal(typeof initialShellState.installStatus.phase, "string");

        const shellState = await daemon.request("app:get-shell-state");
        assert.ok(shellState.settings);
        assert.ok(shellState.installStatus);

        const detected = await daemon.request("archives:list-detected");
        assert.ok(Array.isArray(detected));
        assert.ok(
          detected.some((archive) => archive && archive.path === archivePath),
          `expected detected archives to include ${archivePath}, got ${JSON.stringify(detected)}`
        );
      } finally {
        await daemon.stop();
      }
    });
  });
});
