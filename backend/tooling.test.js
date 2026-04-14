const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const Module = require("node:module");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectTooling, ensureRuntimeTools, installMissingRuntimeTools, __testing } = require("./tooling");

function createHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function createScriptedChild({ stdout = "", stderr = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  process.nextTick(() => {
    if (stdout) {
      child.stdout.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      child.stderr.emit("data", Buffer.from(stderr));
    }
    child.emit("close", code);
  });

  return child;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

async function populateManagedExtraction(destinationPath) {
  await fs.mkdir(destinationPath, { recursive: true });
  await fs.writeFile(path.join(destinationPath, "zstd.exe"), "zstd");
  await fs.writeFile(path.join(destinationPath, "cjxl.exe"), "cjxl");
  await fs.writeFile(path.join(destinationPath, "djxl.exe"), "djxl");
}

function createExtractionChild(destinationPath) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};

  process.nextTick(async () => {
    try {
      await populateManagedExtraction(destinationPath);
      child.emit("close", 0);
    } catch (error) {
      child.emit("error", error);
    }
  });

  return child;
}

async function withMissingOptionalDependencies(run) {
  const missing = new Set(["sharp", "ffmpeg-static", "ffprobe-static"]);
  const originalLoad = Module._load;
  const modulePaths = ["./tooling", "./mediaTools"].map((modulePath) => require.resolve(modulePath));

  Module._load = function patchedLoad(request, parent, isMain) {
    if (missing.has(request)) {
      const error = new Error(`Cannot find module '${request}'`);
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  for (const modulePath of modulePaths) {
    delete require.cache[modulePath];
  }

  try {
    return await run();
  } finally {
    Module._load = originalLoad;
    for (const modulePath of modulePaths) {
      delete require.cache[modulePath];
    }
  }
}

test("backend tooling and media modules load without optional runtime dependencies", async () => {
  await withMissingOptionalDependencies(async () => {
    const tooling = require("./tooling");
    const mediaTools = require("./mediaTools");

    assert.equal(tooling.createInstallStatus().message, "Checking local tooling");
    assert.equal(mediaTools.classifyPath("photo.jpg"), "file");
    assert.equal(mediaTools.classifyPath("clip.mp4"), "video");

    const capabilities = await tooling.detectTooling({
      probeTimeoutMs: 20,
      commandRunner: () => createHangingChild()
    });

    assert.equal(capabilities.ffmpeg.available, false);
    assert.equal(capabilities.ffprobe.available, false);
    assert.equal(capabilities.av1Encoder.available, false);
  });
});

test("tool detection times out instead of hanging on blocked probes", async () => {
  const start = Date.now();
  const capabilities = await detectTooling({
    probeTimeoutMs: 20,
    commandRunner: () => createHangingChild()
  });
  const elapsedMs = Date.now() - start;

  assert.equal(capabilities.zstd.available, false);
  assert.equal(capabilities.cjxl.available, false);
  assert.equal(capabilities.djxl.available, false);
  assert.equal(capabilities.lzma2Offline.available, false);
  assert.ok(elapsedMs < 1_000, `expected timed-out detection to finish quickly, got ${elapsedMs}ms`);
});

test("runtime tooling setup performs detection only until an explicit installer is invoked", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-tooling-test-"));
  try {
    const start = Date.now();
    const result = await ensureRuntimeTools({
      toolsDir: path.join(tempDir, "tools"),
      commandRunner: () => createHangingChild(),
      probeTimeoutMs: 20,
      installTimeoutMs: 20
    });
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 5_000, `expected detection-only flow to finish quickly, got ${elapsedMs}ms`);
    assert.equal(result.attempted, false);
    assert.ok(Array.isArray(result.installed));
    assert.ok(Array.isArray(result.skipped));
    assert.ok(result.installed.length === 0);
    assert.ok(result.skipped.length === 0);
    assert.ok(result.capabilities);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("explicit tooling installation helper remains separate from detection", async () => {
  assert.equal(typeof installMissingRuntimeTools, "function");
});

test("installer candidate parsing requires an explicit prefix", () => {
  assert.equal(__testing.normalizeInstallCandidate("brew:zstd").type, "brew");
  assert.equal(__testing.normalizeInstallCandidate("managed:cjxl").type, "managed");
  assert.equal(__testing.normalizeInstallCandidate("zstd"), null);
});

test("automatic installer trust is limited to managed packages on Windows", async () => {
  await withPlatform("win32", async () => {
    assert.equal(__testing.candidateIsTrustedAutomaticInstall({ type: "managed", name: "zstd" }), true);
    assert.equal(__testing.candidateIsTrustedAutomaticInstall({ type: "brew", name: "zstd" }), false);
    assert.equal(__testing.candidateIsTrustedAutomaticInstall({ type: "winget", name: "7zip" }), false);
  });

  await withPlatform("darwin", async () => {
    assert.equal(__testing.candidateIsTrustedAutomaticInstall({ type: "managed", name: "zstd" }), false);
  });
});

test("automatic install refuses package-manager candidates with a clear manual-install message", async () => {
  await withPlatform("darwin", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-tooling-refuse-package-managers-"));
    const commands = [];

    const commandRunner = (command, args) => {
      commands.push({ command, args });
      return createScriptedChild({ code: 1 });
    };

    try {
      const result = await installMissingRuntimeTools({
        toolsDir: path.join(tempDir, "tools"),
        commandRunner,
        probeTimeoutMs: 20,
        installTimeoutMs: 20
      });

      assert.equal(result.attempted, false);
      assert.ok(result.skipped.some((message) => message.includes("trusted automatic path")));
      assert.ok(result.skipped.some((message) => message.includes("manual installation")));
      assert.ok(!commands.some((entry) => entry.command === "brew"));
      assert.ok(!commands.some((entry) => entry.command === "winget"));
      assert.ok(!commands.some((entry) => entry.command === "powershell"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("managed installers pin release tags and validate installed versions", async () => {
  await withPlatform("win32", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-tooling-managed-success-"));
    const releaseUrls = [];
    const zstdArchive = Buffer.from("zstd-archive");
    const cjxlArchive = Buffer.from("cjxl-archive");

    const releaseByUrl = new Map([
      [
        "https://api.github.com/repos/facebook/zstd/releases/tags/v1.5.7",
        {
          tag_name: "v1.5.7",
          assets: [
            {
              name: "zstd-v1.5.7-win64.zip",
              browser_download_url: "https://downloads.test/zstd.zip"
            }
          ]
        }
      ],
      [
        "https://api.github.com/repos/libjxl/libjxl/releases/tags/v0.11.2",
        {
          tag_name: "v0.11.2",
          assets: [
            {
              name: "jxl-x64-windows-static.zip",
              browser_download_url: "https://downloads.test/jxl.zip",
              digest: `sha256:${sha256Hex(cjxlArchive)}`
            }
          ]
        }
      ]
    ]);

    const fetchJson = async (url) => {
      releaseUrls.push(url);
      const release = releaseByUrl.get(url);
      if (!release) {
        throw new Error(`unexpected release url: ${url}`);
      }
      return release;
    };

    const fetchBuffer = async (url) => {
      if (url === "https://downloads.test/zstd.zip") {
        return zstdArchive;
      }
      if (url === "https://downloads.test/jxl.zip") {
        return cjxlArchive;
      }
      throw new Error(`unexpected download url: ${url}`);
    };

    const commandRunner = (command, args) => {
      if (command === "7z" && args[0] === "i") {
        return createScriptedChild({ stdout: "7-Zip 23.01", code: 0 });
      }
      if (command === "7zz" && args[0] === "--help") {
        return createScriptedChild({ code: 1 });
      }
      if ((command === "zstd" || command === "cjxl" || command === "djxl") && args[0] === "--version") {
        return createScriptedChild({ code: 1 });
      }
      if (command === "powershell") {
        const destinationArg = args.find((arg) => typeof arg === "string" && arg.includes("-DestinationPath"));
        const match = destinationArg?.match(/-DestinationPath '([^']+)'/);
        const destinationPath = match?.[1];
        if (!destinationPath) {
          return createScriptedChild({ stderr: "missing destination", code: 1 });
        }
        return createExtractionChild(destinationPath);
      }
      if (command.endsWith(".exe") && args[0] === "--version") {
        const version = command.includes("zstd") ? "1.5.7" : "0.11.2";
        return createScriptedChild({ stdout: `${command} ${version}`, code: 0 });
      }
      return createScriptedChild({ code: 1 });
    };

    const originalPath = process.env.PATH;
    try {
      const result = await installMissingRuntimeTools({
        toolsDir: path.join(tempDir, "tools"),
        fetchJson,
        fetchBuffer,
        commandRunner,
        probeTimeoutMs: 20,
        installTimeoutMs: 20
      });

      assert.equal(result.attempted, true);
      assert.ok(result.installed.some((message) => message.includes("v1.5.7")));
      assert.ok(result.installed.some((message) => message.includes("v0.11.2")));
      assert.deepEqual(
        releaseUrls.sort(),
        [
          "https://api.github.com/repos/facebook/zstd/releases/tags/v1.5.7",
          "https://api.github.com/repos/libjxl/libjxl/releases/tags/v0.11.2"
        ]
      );
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("managed installers reject checksum mismatches from release metadata", async () => {
  await withPlatform("win32", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-tooling-managed-checksum-"));
    const archive = Buffer.from("cjxl-archive");
    const zstdArchive = Buffer.from("zstd-archive");
    const releaseUrls = [];

    const fetchJson = async (url) => {
      releaseUrls.push(url);
      if (url === "https://api.github.com/repos/facebook/zstd/releases/tags/v1.5.7") {
        return {
          tag_name: "v1.5.7",
          assets: [
            {
              name: "zstd-v1.5.7-win64.zip",
              browser_download_url: "https://downloads.test/zstd.zip"
            }
          ]
        };
      }
      if (url === "https://api.github.com/repos/libjxl/libjxl/releases/tags/v0.11.2") {
        return {
          tag_name: "v0.11.2",
          assets: [
            {
              name: "jxl-x64-windows-static.zip",
              browser_download_url: "https://downloads.test/jxl.zip",
              digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
            }
          ]
        };
      }
      throw new Error(`unexpected release url: ${url}`);
    };

    const fetchBuffer = async (url) => {
      if (url === "https://downloads.test/zstd.zip") {
        return zstdArchive;
      }
      if (url === "https://downloads.test/jxl.zip") {
        return archive;
      }
      throw new Error(`unexpected download url: ${url}`);
    };

    const commandRunner = (command, args) => {
      if (command === "7z" && args[0] === "i") {
        return createScriptedChild({ stdout: "7-Zip 23.01", code: 0 });
      }
      if (command === "zstd" && args[0] === "--version") {
        return createScriptedChild({ stdout: "zstd 1.5.7", code: 0 });
      }
      if (command === "cjxl" && args[0] === "--version") {
        return createScriptedChild({ code: 1 });
      }
      if (command === "djxl" && args[0] === "--version") {
        return createScriptedChild({ code: 1 });
      }
      if (command === "powershell") {
        const destinationArg = args.find((arg) => typeof arg === "string" && arg.includes("-DestinationPath"));
        const match = destinationArg?.match(/-DestinationPath '([^']+)'/);
        const destinationPath = match?.[1];
        if (!destinationPath) {
          return createScriptedChild({ stderr: "missing destination", code: 1 });
        }
        return createExtractionChild(destinationPath);
      }
      if (command.endsWith(".exe") && args[0] === "--version") {
        return createScriptedChild({ stdout: `${command} 1.5.7`, code: 0 });
      }
      return createScriptedChild({ code: 1 });
    };

    const originalPath = process.env.PATH;
    try {
      const result = await installMissingRuntimeTools({
        toolsDir: path.join(tempDir, "tools"),
        fetchJson,
        fetchBuffer,
        commandRunner,
        probeTimeoutMs: 20,
        installTimeoutMs: 20
      });

      assert.equal(result.attempted, true);
      assert.ok(result.skipped.some((message) => message.includes("Checksum mismatch")));
      assert.deepEqual(
        releaseUrls,
        ["https://api.github.com/repos/libjxl/libjxl/releases/tags/v0.11.2"]
      );
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

test("managed installers reject version mismatches after install", async () => {
  await withPlatform("win32", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-tooling-managed-version-"));
    const zstdArchive = Buffer.from("zstd-archive");
    const releaseUrls = [];

    const fetchJson = async (url) => {
      releaseUrls.push(url);
      if (url === "https://api.github.com/repos/facebook/zstd/releases/tags/v1.5.7") {
        return {
          tag_name: "v1.5.7",
          assets: [
            {
              name: "zstd-v1.5.7-win64.zip",
              browser_download_url: "https://downloads.test/zstd.zip"
            }
          ]
        };
      }
      throw new Error(`unexpected release url: ${url}`);
    };

    const fetchBuffer = async (url) => {
      if (url === "https://downloads.test/zstd.zip") {
        return zstdArchive;
      }
      throw new Error(`unexpected download url: ${url}`);
    };

    const commandRunner = (command, args) => {
      if (command === "7z" && args[0] === "i") {
        return createScriptedChild({ stdout: "7-Zip 23.01", code: 0 });
      }
      if (command === "zstd" && args[0] === "--version") {
        return createScriptedChild({ code: 1 });
      }
      if (command === "cjxl" && args[0] === "--version") {
        return createScriptedChild({ stdout: "cjxl v0.11.2", code: 0 });
      }
      if (command === "djxl" && args[0] === "--version") {
        return createScriptedChild({ stdout: "djxl v0.11.2", code: 0 });
      }
      if (command === "powershell") {
        const destinationArg = args.find((arg) => typeof arg === "string" && arg.includes("-DestinationPath"));
        const match = destinationArg?.match(/-DestinationPath '([^']+)'/);
        const destinationPath = match?.[1];
        if (!destinationPath) {
          return createScriptedChild({ stderr: "missing destination", code: 1 });
        }
        return createExtractionChild(destinationPath);
      }
      if (command.endsWith(".exe") && args[0] === "--version") {
        return createScriptedChild({ stdout: `${command} 0.0.0`, code: 0 });
      }
      return createScriptedChild({ code: 1 });
    };

    const originalPath = process.env.PATH;
    try {
      const result = await installMissingRuntimeTools({
        toolsDir: path.join(tempDir, "tools"),
        fetchJson,
        fetchBuffer,
        commandRunner,
        probeTimeoutMs: 20,
        installTimeoutMs: 20
      });

      assert.equal(result.attempted, true);
      assert.ok(result.skipped.some((message) => message.includes("version mismatch")));
      assert.deepEqual(
        releaseUrls,
        ["https://api.github.com/repos/facebook/zstd/releases/tags/v1.5.7"]
      );
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
