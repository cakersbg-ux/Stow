const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sharp = require("sharp");
const mime = require("mime-types");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { v4: uuid } = require("uuid");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".avif", ".jxl"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const LOSSLESS_IMAGE_EXTENSIONS = new Set([".png", ".tif", ".tiff", ".bmp", ".jxl"]);
const LIKELY_LOSSY_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".webp", ".avif"]);
const BAD_IMAGE_TRANSCODE_EXTENSIONS = new Set([".gif", ".svg"]);

function extname(filePath) {
  return path.extname(filePath).toLowerCase();
}

function classifyPath(filePath) {
  const extension = extname(filePath);
  if (IMAGE_EXTENSIONS.has(extension)) {
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

async function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderr).toString().trim();
        const stdoutText = Buffer.concat(stdout).toString().trim();
        reject(new Error(stderrText || stdoutText || `${command} exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegStatic, args);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || "ffmpeg failed"));
        return;
      }
      resolve(stderr);
    });
  });
}

async function getVideoProbe(filePath) {
  const output = await spawnCapture(ffprobeStatic.path, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ]);
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
  if (preferences.optimizationMode === "lossless" && likelyLossySource) {
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
    "cjxl",
    buildJxlEncodeArgs(sourceForEncode, outputJxlPath, {
      mathematicallyLossless: preferences.optimizationMode === "lossless" && mathematicallyLosslessSource
    })
  );

  return {
    derivative: {
      label: preferences.optimizationMode === "lossless" ? "optimized_lossless" : "optimized_visual",
      path: outputJxlPath,
      extension: ".jxl",
      mime: "image/jxl",
      actions: [
        preferences.optimizationMode === "lossless" && mathematicallyLosslessSource
          ? "transcoded to JPEG XL lossless"
          : "transcoded to JPEG XL visually lossless"
      ]
    },
    actions
  };
}

async function transcodeVideo(filePath, preferences, capabilities, workDir) {
  const probe = await getVideoProbe(filePath);
  const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
  const actions = [];
  const sourceLossless = isLosslessCodec(videoStream?.codec_name);
  let derivative = null;

  if (preferences.optimizationMode === "lossless" && sourceLossless) {
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
  } else if (preferences.optimizationMode === "lossless") {
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

async function generatePreviewFile(sourcePath, kind, variant, outputDir) {
  const previewSize = variant === "thumbnail" ? 128 : 320;
  await fs.mkdir(outputDir, { recursive: true });

  if (kind === "image") {
    const webpPath = path.join(outputDir, `${variant}.webp`);
    try {
      await sharp(sourcePath)
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
      await sharp(sourcePath)
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
  }

  if (kind === "video" && ffmpegStatic) {
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

async function analyzePath(filePath, preferences, capabilities, workDir) {
  const normalizedPreferences = {
    ...preferences,
    optimizationMode:
      preferences.optimizationMode === "pick_per_file" ? "visually_lossless" : preferences.optimizationMode
  };
  const kind = classifyPath(filePath);
  if (kind === "image") {
    return optimizeImage(filePath, normalizedPreferences, capabilities, workDir);
  }
  if (kind === "video") {
    return optimizeVideo(filePath, normalizedPreferences, capabilities, workDir);
  }

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
    actions: ["stored as general file object"],
    summary: "generic file",
    previewSourcePath: null
  };
}

module.exports = {
  analyzePath,
  classifyPath,
  generatePreviewFile
};
