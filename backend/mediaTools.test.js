const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function createHangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

function withImmediateTimeouts(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  global.setTimeout = (callback, _delay, ...args) => {
    const handle = { cleared: false };
    queueMicrotask(() => {
      if (!handle.cleared) {
        callback(...args);
      }
    });
    return handle;
  };
  global.clearTimeout = (handle) => {
    if (handle) {
      handle.cleared = true;
    }
  };

  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });
}

async function withMediaTools(overrides, run) {
  const modulePath = require.resolve("./mediaTools");
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(overrides, request)) {
      return overrides[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[modulePath];

  try {
    const mediaTools = require("./mediaTools");
    return await run(mediaTools);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

async function withTempDir(prefix, run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("video previews time out instead of hanging on ffmpeg", async () => {
  const spawnCalls = [];
  await withImmediateTimeouts(async () =>
    withMediaTools(
      {
        "node:child_process": {
          spawn: (...args) => {
            const child = createHangingChild();
            spawnCalls.push({ args, child });
            return child;
          }
        },
        "ffmpeg-static": "/usr/bin/ffmpeg"
      },
      async ({ generatePreviewFile }) => {
        await withTempDir("stow-media-timeout-ffmpeg-", async (tempDir) => {
          await assert.rejects(
            () => generatePreviewFile("movie.mp4", "video", "thumbnail", tempDir),
            /timed out after \d+ms/
          );
        });
      }
    )
  );

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].child.killCalls, ["SIGKILL"]);
});

test("video analysis times out instead of hanging on ffprobe", async () => {
  const spawnCalls = [];
  await withImmediateTimeouts(async () =>
    withMediaTools(
      {
        "node:child_process": {
          spawn: (...args) => {
            const child = createHangingChild();
            spawnCalls.push({ args, child });
            return child;
          }
        },
        "ffprobe-static": { path: "/usr/bin/ffprobe" }
      },
      async ({ analyzePath }) => {
        await withTempDir("stow-media-timeout-ffprobe-", async (tempDir) => {
          const videoPath = path.join(tempDir, "movie.mp4");
          await fs.writeFile(videoPath, "placeholder");
          await assert.rejects(
            () => analyzePath(videoPath, { optimizationMode: "visually_lossless" }, {}, tempDir),
            /timed out after \d+ms/
          );
        });
      }
    )
  );

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].child.killCalls, ["SIGKILL"]);
});

test("image transcoding times out instead of hanging on cjxl", async (t) => {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (_error) {
    t.skip("sharp is not available");
    return;
  }

  const spawnCalls = [];
  await withImmediateTimeouts(async () =>
    withMediaTools(
      {
        "node:child_process": {
          spawn: (...args) => {
            const child = createHangingChild();
            spawnCalls.push({ args, child });
            return child;
          }
        }
      },
      async ({ analyzePath }) => {
        await withTempDir("stow-media-timeout-cjxl-", async (tempDir) => {
          const imagePath = path.join(tempDir, "source.png");
          await sharp({
            create: {
              width: 32,
              height: 32,
              channels: 3,
              background: { r: 48, g: 96, b: 192 }
            }
          })
            .png()
            .toFile(imagePath);

          await assert.rejects(
            () =>
              analyzePath(
                imagePath,
                { optimizationMode: "visually_lossless", stripDerivativeMetadata: false },
                { cjxl: { available: true, path: "/usr/bin/cjxl" } },
                tempDir
              ),
            /timed out after \d+ms/
          );
        });
      }
    )
  );

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].child.killCalls, ["SIGKILL"]);
});

test("jpeg xl decoding times out instead of hanging on djxl", async () => {
  const spawnCalls = [];
  await withImmediateTimeouts(async () =>
    withMediaTools(
      {
        "node:child_process": {
          spawn: (...args) => {
            const child = createHangingChild();
            spawnCalls.push({ args, child });
            return child;
          }
        },
        sharp: {
          format: {
            jxl: {
              input: {
                file: false
              }
            }
          }
        }
      },
      async ({ analyzePath }) => {
        await withTempDir("stow-media-timeout-djxl-", async (tempDir) => {
          const jxlPath = path.join(tempDir, "source.jxl");
          await fs.writeFile(jxlPath, "placeholder");

          await assert.rejects(
            () =>
              analyzePath(
                jxlPath,
                { optimizationMode: "visually_lossless", stripDerivativeMetadata: false },
                { djxl: { available: true, path: "/usr/bin/djxl" } },
                tempDir
              ),
            /timed out after \d+ms/
          );
        });
      }
    )
  );

  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].child.killCalls, ["SIGKILL"]);
});
