const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mime = require("mime-types");
const { v4: uuid } = require("uuid");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".avif", ".jxl"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const LOSSLESS_IMAGE_EXTENSIONS = new Set([".png", ".tif", ".tiff", ".bmp", ".jxl"]);
const LIKELY_LOSSY_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".webp", ".avif"]);
const BAD_IMAGE_TRANSCODE_EXTENSIONS = new Set([".gif", ".svg"]);
const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;
const DEFAULT_FFPROBE_TIMEOUT_MS = 30_000;
const DEFAULT_CJXL_TIMEOUT_MS = 120_000;
const DEFAULT_DJXL_TIMEOUT_MS = 120_000;
const SHARP_INPUT_FORMAT_BY_EXTENSION = new Map([
  [".jpg", "jpeg"],
  [".jpeg", "jpeg"],
  [".png", "png"],
  [".webp", "webp"],
  [".tif", "tiff"],
  [".tiff", "tiff"],
  [".gif", "gif"],
  [".avif", "heif"],
  [".jxl", "jxl"]
]);

let sharpModule = null;
let sharpModuleLoaded = false;
let ffmpegStaticPath = null;
let ffmpegStaticLoaded = false;
let ffprobeStatic = null;
let ffprobeStaticLoaded = false;

function loadOptionalModule(moduleName) {
  try {
    return require(moduleName);
  } catch (error) {
    if (error instanceof Error && error.code === "MODULE_NOT_FOUND" && error.message.includes(`'${moduleName}'`)) {
      return null;
    }
    throw error;
  }
}

function getSharp() {
  if (!sharpModuleLoaded) {
    sharpModule = loadOptionalModule("sharp");
    sharpModuleLoaded = true;
  }
  return sharpModule;
}

function getFfmpegStaticPath() {
  if (!ffmpegStaticLoaded) {
    ffmpegStaticPath = loadOptionalModule("ffmpeg-static");
    ffmpegStaticLoaded = true;
  }
  return ffmpegStaticPath;
}

function getFfprobeStatic() {
  if (!ffprobeStaticLoaded) {
    ffprobeStatic = loadOptionalModule("ffprobe-static");
    ffprobeStaticLoaded = true;
  }
  return ffprobeStatic;
}

function extname(filePath) {
  return path.extname(filePath).toLowerCase();
}

function resolveOptimizationTier(preferences = {}) {
  if (preferences.optimizationMode === "pick_per_file") {
    return "visually_lossless";
  }
  if (typeof preferences.optimizationTier === "string") {
    return preferences.optimizationTier;
  }
  if (typeof preferences.optimizationMode === "string") {
    return preferences.optimizationMode;
  }
  return "visually_lossless";
}

function supportsSharpImageInput(filePath) {
  const sharp = getSharp();
  if (!sharp) {
    return false;
  }
  const formatId = SHARP_INPUT_FORMAT_BY_EXTENSION.get(extname(filePath));
  return Boolean(formatId && sharp.format[formatId]?.input?.file);
}

function canDecodeWithDjxl(filePath, capabilities) {
  return extname(filePath) === ".jxl" && Boolean(capabilities?.djxl?.available);
}

function classifyPath(filePath) {
  const extension = extname(filePath);
  if (IMAGE_EXTENSIONS.has(extension) && supportsSharpImageInput(filePath)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return "file";
}

function fileDisplayType(filePath) {
  return mime.lookup(filePath) || "application/octet-stream";
}

function buildOpaqueFileAnalysis(filePath, action = "stored as general file object") {
  return {
    kind: "file",
    original: {
      path: filePath,
      extension: extname(filePath),
      mime: fileDisplayType(filePath),
      width: null,
      height: null,
      codec: null
    },
    derivative: null,
    actions: [action],
    summary: "generic file",
    previewSourcePath: null
  };
}

function normalizeTimeoutMs(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }

  return Math.floor(timeoutMs);
}

async function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs: requestedTimeoutMs, ...spawnOptions } = options;
    const timeoutMs = normalizeTimeoutMs(requestedTimeoutMs);
    let child;
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timeoutId = null;

    const settle = (callback) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      callback();
    };

    try {
      child = spawn(command, args, spawnOptions);
    } catch (error) {
      reject(error);
      return;
    }

    child.stdout?.on?.("data", (chunk) => stdout.push(chunk));
    child.stderr?.on?.("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) =>
      settle(() => {
        reject(error);
      })
    );
    child.on("close", (code) =>
      settle(() => {
        if (code !== 0) {
          const stderrText = Buffer.concat(stderr).toString().trim();
          const stdoutText = Buffer.concat(stdout).toString().trim();
          reject(new Error(stderrText || stdoutText || `${command} exited with code ${code ?? "unknown"}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      })
    );

    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        settle(() => {
          try {
            child.kill?.("SIGKILL");
          } catch (_error) {
            // The timeout result is authoritative even if termination fails.
          }
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
    }
  });
}

async function runFfmpeg(args) {
  const ffmpegStatic = getFfmpegStaticPath();
  if (!ffmpegStatic) {
    throw new Error("ffmpeg-static is not available");
  }

  await spawnCapture(ffmpegStatic, args, {
    timeoutMs: DEFAULT_FFMPEG_TIMEOUT_MS
  });
}

async function decodeJxlToPng(sourcePath, outputPath, capabilities) {
    const djxlCommand = capabilities?.djxl?.path || "djxl";
  await spawnCapture(djxlCommand, [sourcePath, outputPath], {
    timeoutMs: DEFAULT_DJXL_TIMEOUT_MS
  });
  return outputPath;
}

async function detectAv1Encoder() {
  const ffmpegStatic = getFfmpegStaticPath();
  if (!ffmpegStatic) {
    return null;
  }

  try {
    const output = await spawnCapture(ffmpegStatic, ["-hide_banner", "-encoders"], {
      timeoutMs: DEFAULT_FFMPEG_TIMEOUT_MS
    });
    if (/\blibsvtav1\b/.test(output)) {
      return "libsvtav1";
    }
    if (/\blibaom-av1\b/.test(output)) {
      return "libaom-av1";
    }
  } catch (_error) {
    return null;
  }

  return null;
}

async function getVideoProbe(filePath) {
  const ffprobeStatic = getFfprobeStatic();
  if (!ffprobeStatic?.path) {
    throw new Error("ffprobe-static is not available");
  }

  const output = await spawnCapture(ffprobeStatic.path, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ], {
    timeoutMs: DEFAULT_FFPROBE_TIMEOUT_MS
  });
  return JSON.parse(output);
}

function isLosslessCodec(codecName) {
  return ["ffv1", "huffyuv", "utvideo", "rawvideo", "png", "ffvhuff"].includes((codecName || "").toLowerCase());
}

function buildJxlEncodeArgs(inputPath, outputPath, options = {}) {
  const inputExtension = extname(inputPath);
  const { effort = 7, visuallyLosslessDistance = 1.0, mathematicallyLossless = false } = options;

  if (mathematicallyLossless) {
    const baseArgs = [inputPath, outputPath, `--effort=${effort}`];
    if (inputExtension === ".png" || inputExtension === ".jxl") {
      return [...baseArgs, "--modular=1"];
    }
    return [...baseArgs, "--distance=0"];
  }

  return [inputPath, outputPath, `--effort=${effort}`, `--distance=${visuallyLosslessDistance}`];
}

function canUseDirectJxlInput(inputPath, stripDerivativeMetadata) {
  return Boolean(inputPath) && !stripDerivativeMetadata;
}

async function transcodeImageToJxl(filePath, preferences, capabilities, workDir, metadata) {
  const actions = [];
  const extension = extname(filePath);
  const derivative = null;
  const cjxlCommand = capabilities?.cjxl?.path || "cjxl";
  const sharp = getSharp();
  const tier = resolveOptimizationTier(preferences);

  if ((metadata.pages || 1) > 1 || BAD_IMAGE_TRANSCODE_EXTENSIONS.has(extension)) {
    actions.push("preserved original because this image format is not eligible for derivative transcoding");
    return { derivative, actions };
  }

  if (!capabilities?.cjxl?.available) {
    actions.push("no JPEG XL derivative created");
    return { derivative, actions };
  }

  const mathematicallyLosslessSource = LOSSLESS_IMAGE_EXTENSIONS.has(extension);
  const likelyLossySource = LIKELY_LOSSY_IMAGE_EXTENSIONS.has(extension);
  if (tier === "lossless" && likelyLossySource) {
    actions.push("preserved original because source is already lossy");
    return { derivative, actions };
  }

  const outputJxlPath = path.join(workDir, `${uuid()}.jxl`);
  const sourceForEncode = canUseDirectJxlInput(filePath, preferences.stripDerivativeMetadata)
    ? filePath
    : path.join(workDir, `${uuid()}.png`);

  if (sourceForEncode !== filePath) {
    let pipeline = sharp(filePath);
    if (!preferences.stripDerivativeMetadata) {
      pipeline = pipeline.withMetadata();
    }
    await pipeline.png().toFile(sourceForEncode);
  }

  await spawnCapture(
    cjxlCommand,
    buildJxlEncodeArgs(sourceForEncode, outputJxlPath, {
      mathematicallyLossless: tier === "lossless" && mathematicallyLosslessSource
    }),
    {
      timeoutMs: DEFAULT_CJXL_TIMEOUT_MS
    }
  );

  return {
    derivative: {
      label: tier === "lossless" ? "optimized_lossless" : "optimized_visual",
      path: outputJxlPath,
      extension: ".jxl",
      mime: "image/jxl",
      actions: [
        tier === "lossless" && mathematicallyLosslessSource
          ? "transcoded to JPEG XL lossless"
          : "transcoded to JPEG XL visually lossless"
      ]
    },
    actions
  };
}

async function optimizeDecodedJxlImage(filePath, capabilities, workDir) {
  const sharp = getSharp();
  if (!sharp) {
    return buildOpaqueFileAnalysis(filePath, "stored as general file object because sharp is unavailable");
  }

  const decodedPath = await decodeJxlToPng(filePath, path.join(workDir, `${uuid()}.png`), capabilities);
  const metadata = await sharp(decodedPath, { animated: true }).metadata();

  return {
    kind: "image",
    original: {
      path: filePath,
      extension: extname(filePath),
      mime: fileDisplayType(filePath),
      width: metadata.width || null,
      height: metadata.height || null,
      codec: null
    },
    derivative: null,
    actions: [
      "decoded JPEG XL with djxl for analysis and previews",
      "preserved original because source is already JPEG XL"
    ],
    summary: `${metadata.width || "?"}x${metadata.height || "?"}`,
    previewSourcePath: decodedPath
  };
}

async function transcodeVideo(filePath, preferences, capabilities, workDir) {
  const probe = await getVideoProbe(filePath);
  const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
  const actions = [];
  const sourceLossless = isLosslessCodec(videoStream?.codec_name);
  let derivative = null;
  const tier = resolveOptimizationTier(preferences);

  if (tier === "lossless" && sourceLossless) {
    const outputPath = path.join(workDir, `${uuid()}.mkv`);
    await runFfmpeg([
      "-y",
      "-i",
      filePath,
      "-map",
      "0",
      "-c:v",
      "ffv1",
      "-level",
      "3",
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      outputPath
    ]);
    derivative = {
      label: "archival_master_ffv1",
      path: outputPath,
      extension: ".mkv",
      mime: "video/x-matroska",
      actions: ["transcoded to FFV1 lossless archival master"]
    };
  } else if (tier === "lossless") {
    actions.push("preserved original because source video is already lossy");
  } else if (capabilities?.av1Encoder?.value) {
    const outputPath = path.join(workDir, `${uuid()}.mkv`);
    await runFfmpeg([
      "-y",
      "-i",
      filePath,
      "-map",
      "0",
      "-c:v",
      capabilities.av1Encoder.value,
      ...(capabilities.av1Encoder.value === "libsvtav1" ? ["-crf", "28", "-preset", "5"] : ["-crf", "30", "-cpu-used", "4"]),
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      outputPath
    ]);
    derivative = {
      label: "optimized_access_av1",
      path: outputPath,
      extension: ".mkv",
      mime: "video/x-matroska",
      actions: ["generated AV1 access copy with audio and subtitle streams preserved"]
    };
  } else {
    actions.push("AV1 encoder unavailable in ffmpeg build");
  }

  return { derivative, actions, videoStream };
}

async function optimizeImage(filePath, preferences, capabilities, workDir) {
  const sharp = getSharp();
  if (!sharp) {
    return buildOpaqueFileAnalysis(filePath, "stored as general file object because sharp is unavailable");
  }

  const metadata = await sharp(filePath, { animated: true }).metadata();
  const extension = extname(filePath);
  const actions = [];
  const imageResult = await transcodeImageToJxl(filePath, preferences, capabilities, workDir, metadata);

  actions.push(...imageResult.actions);

  return {
    kind: "image",
    original: {
      path: filePath,
      extension,
      mime: fileDisplayType(filePath),
      width: metadata.width || null,
      height: metadata.height || null,
      codec: null
    },
    derivative: imageResult.derivative,
    actions,
    summary: `${metadata.width || "?"}x${metadata.height || "?"}`,
    previewSourcePath: imageResult.derivative?.path || filePath
  };
}

async function optimizeVideo(filePath, preferences, capabilities, workDir) {
  const { derivative, actions, videoStream } = await transcodeVideo(filePath, preferences, capabilities, workDir);
  const extension = extname(filePath);

  return {
    kind: "video",
    original: {
      path: filePath,
      extension,
      mime: fileDisplayType(filePath),
      width: videoStream?.width || null,
      height: videoStream?.height || null,
      codec: videoStream?.codec_name || null
    },
    derivative,
    actions,
    summary: `${videoStream?.codec_name || "unknown"} ${videoStream?.width || "?"}x${videoStream?.height || "?"}`,
    previewSourcePath: derivative?.path || filePath
  };
}

async function generatePreviewFile(sourcePath, kind, variant, outputDir, capabilities = {}) {
  const previewSize = variant === "thumbnail" ? 128 : 320;
  await fs.mkdir(outputDir, { recursive: true });

  if (kind === "image") {
    const sharp = getSharp();
    if (!sharp) {
      return null;
    }

    let sharpSourcePath = sourcePath;
    let tempDir = null;

    if (!supportsSharpImageInput(sourcePath)) {
      if (!canDecodeWithDjxl(sourcePath, capabilities)) {
        return null;
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stow-preview-jxl-"));
      sharpSourcePath = await decodeJxlToPng(sourcePath, path.join(tempDir, "decoded.png"), capabilities);
    }

    const webpPath = path.join(outputDir, `${variant}.webp`);
    try {
      try {
        await sharp(sharpSourcePath)
          .resize({
            width: previewSize,
            height: previewSize,
            fit: "inside",
            withoutEnlargement: true
          })
          .webp({ quality: 72, effort: 4 })
          .toFile(webpPath);
        return {
          path: webpPath,
          mime: "image/webp"
        };
      } catch (_error) {
        const pngPath = path.join(outputDir, `${variant}.png`);
        await sharp(sharpSourcePath)
          .resize({
            width: previewSize,
            height: previewSize,
            fit: "inside",
            withoutEnlargement: true
          })
          .png()
          .toFile(pngPath);
        return {
          path: pngPath,
          mime: "image/png"
        };
      }
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (kind === "video") {
    const ffmpegStaticPath = getFfmpegStaticPath();
    if (!ffmpegStaticPath) {
      return null;
    }

    const jpegPath = path.join(outputDir, `${variant}.jpg`);
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${previewSize}:-1:flags=lanczos`,
      "-q:v",
      variant === "thumbnail" ? "7" : "5",
      jpegPath
    ]);
    return {
      path: jpegPath,
      mime: "image/jpeg"
    };
  }

  return null;
}

async function analyzePath(filePath, preferences, capabilities, workDir, options = {}) {
  const shouldOptimize = options.optimize !== false;
  const normalizedPreferences = {
    ...preferences,
    optimizationTier: resolveOptimizationTier(preferences)
  };
  const extension = extname(filePath);
  if (IMAGE_EXTENSIONS.has(extension) && !supportsSharpImageInput(filePath)) {
    if (canDecodeWithDjxl(filePath, capabilities) && getSharp()) {
      return optimizeDecodedJxlImage(filePath, capabilities, workDir);
    }

    return buildOpaqueFileAnalysis(
      filePath,
      `stored as general file object because ${extension} images are not supported by the bundled image decoder`
    );
  }

  const kind = classifyPath(filePath);
  if (kind === "image") {
    if (!shouldOptimize) {
      const sharp = getSharp();
      if (!sharp) {
        return buildOpaqueFileAnalysis(filePath, "stored as general file object because sharp is unavailable");
      }
      const metadata = await sharp(filePath, { animated: true }).metadata();
      return {
        kind: "image",
        original: {
          path: filePath,
          extension,
          mime: fileDisplayType(filePath),
          width: metadata.width || null,
          height: metadata.height || null,
          codec: null
        },
        derivative: null,
        actions: ["stored baseline image without immediate optimization"],
        summary: `${metadata.width || "?"}x${metadata.height || "?"}`,
        previewSourcePath: filePath
      };
    }
    return optimizeImage(filePath, normalizedPreferences, capabilities, workDir);
  }
  if (kind === "video") {
    if (!shouldOptimize) {
      let probe;
      try {
        probe = await getVideoProbe(filePath);
      } catch (_error) {
        return buildOpaqueFileAnalysis(filePath, "stored as general file object because ffprobe is unavailable");
      }
      const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
      return {
        kind: "video",
        original: {
          path: filePath,
          extension,
          mime: fileDisplayType(filePath),
          width: videoStream?.width || null,
          height: videoStream?.height || null,
          codec: videoStream?.codec_name || null
        },
        derivative: null,
        actions: ["stored baseline video without immediate optimization"],
        summary: `${videoStream?.codec_name || "unknown"} ${videoStream?.width || "?"}x${videoStream?.height || "?"}`,
        previewSourcePath: filePath
      };
    }
    return optimizeVideo(filePath, normalizedPreferences, capabilities, workDir);
  }

  return buildOpaqueFileAnalysis(filePath);
}

module.exports = {
  analyzePath,
  classifyPath,
  detectAv1Encoder,
  generatePreviewFile,
  resolveOptimizationTier
};
