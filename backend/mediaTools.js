const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sharp = require("sharp");
const mime = require("mime-types");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { v4: uuid } = require("uuid");
const { classifyImageWithDistilledModel } = require("./distilledClassifier");
const { classifyImageWithClip } = require("./clipClassifier");
const { extractVisualFeatures } = require("./visualFeatures");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".avif", ".jxl"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);
const LOSSLESS_IMAGE_EXTENSIONS = new Set([".png", ".tif", ".tiff", ".bmp", ".jxl"]);
const LIKELY_LOSSY_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".webp", ".avif"]);
const BAD_IMAGE_TRANSCODE_EXTENSIONS = new Set([".gif", ".svg"]);
const REAL_ESRGAN_COMMANDS = ["realesrgan-ncnn-vulkan", "real-esrgan-ncnn-vulkan"];
const REAL_CUGAN_COMMANDS = ["realcugan-ncnn-vulkan"];
const WAIFU2X_COMMANDS = ["waifu2x-ncnn-vulkan"];
const REAL_ESRGAN_SCALE_FACTORS = [2, 3, 4];
const REAL_CUGAN_SCALE_FACTORS = [2, 3, 4];
const WAIFU2X_SCALE_FACTORS = [2, 4, 8, 16, 32];
const VIDEO_FRAME_PATTERN = "frame-%08d.png";
const ROUTER_CONFIDENCE_THRESHOLD = 0.45;
const VISUAL_CLASSIFICATION_CATEGORIES = ["portrait", "landscape", "photo", "illustration", "anime", "ui_screenshot"];
const ROUTER_THRESHOLDS = {
  distilled: {
    portrait: { confidence: 0.42, margin: 0.08 },
    landscape: { confidence: 0.4, margin: 0.07 },
    photo: { confidence: 0.4, margin: 0.06 },
    illustration: { confidence: 0.52, margin: 0.09 },
    anime: { confidence: 0.54, margin: 0.1 },
    ui_screenshot: { confidence: 0.5, margin: 0.1 }
  },
  clip: {
    portrait: { confidence: 0.36, margin: 0.03 },
    landscape: { confidence: 0.34, margin: 0.03 },
    photo: { confidence: 0.34, margin: 0.03 },
    illustration: { confidence: 0.38, margin: 0.03 },
    anime: { confidence: 0.4, margin: 0.04 },
    ui_screenshot: { confidence: 0.42, margin: 0.05 }
  },
  consensus: {
    portrait: { confidence: 0.38, margin: 0.04 },
    landscape: { confidence: 0.36, margin: 0.04 },
    photo: { confidence: 0.36, margin: 0.03 },
    illustration: { confidence: 0.4, margin: 0.04 },
    anime: { confidence: 0.42, margin: 0.05 },
    ui_screenshot: { confidence: 0.42, margin: 0.05 }
  }
};

const TIER_HEIGHTS = {
  "1080p": 1080,
  "1440p": 1440,
  "4k": 2160
};

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

function resolveTierDimensions(width, height, targetLabel) {
  const targetHeight = TIER_HEIGHTS[targetLabel] || 1080;
  const aspect = width / Math.max(height, 1);
  const sourceHeight = Math.min(width, height);
  const nearestTier = Object.entries(TIER_HEIGHTS).reduce((best, [label, tierHeight]) => {
    const distance = Math.abs(tierHeight - sourceHeight);
    return !best || distance < best.distance ? { label, distance, height: tierHeight } : best;
  }, null);

  const effectiveWidth = aspect >= 1 ? Math.round(targetHeight * aspect) : targetHeight;
  const effectiveHeight = aspect >= 1 ? targetHeight : Math.round(targetHeight / Math.max(aspect, 0.0001));

  return {
    nearestTier: nearestTier?.label ?? targetLabel,
    targetHeight,
    width: effectiveWidth,
    height: effectiveHeight
  };
}

function getAvailableCommand(capability, fallbackCommands = []) {
  if (capability?.available && capability.path) {
    return capability.path;
  }
  return fallbackCommands.find(Boolean) || null;
}

function shouldUpscaleToTarget(width, height, targetHeight) {
  return Boolean(width && height) && Math.min(width, height) < targetHeight;
}

function selectUpscaleFactor(width, height, targetHeight, supportedFactors = REAL_ESRGAN_SCALE_FACTORS) {
  if (!shouldUpscaleToTarget(width, height, targetHeight)) {
    return null;
  }

  const requiredFactor = targetHeight / Math.max(Math.min(width, height), 1);
  for (const factor of supportedFactors) {
    if (factor >= requiredFactor) {
      return factor;
    }
  }
  return supportedFactors[supportedFactors.length - 1] ?? null;
}

function buildRealEsrganArgs({ inputPath, outputPath, scale, modelName, outputFormat = "png", modelPath = null }) {
  return [
    "-i",
    inputPath,
    "-o",
    outputPath,
    "-s",
    String(scale),
    "-n",
    modelName,
    ...(modelPath ? ["-m", modelPath] : []),
    "-f",
    outputFormat
  ];
}

function buildRealCuganArgs({ inputPath, outputPath, scale, noiseLevel = -1, outputFormat = "png", modelPath = null }) {
  return [
    "-i",
    inputPath,
    "-o",
    outputPath,
    "-s",
    String(scale),
    "-n",
    String(noiseLevel),
    ...(modelPath ? ["-m", modelPath] : []),
    "-f",
    outputFormat
  ];
}

function buildWaifu2xArgs({ inputPath, outputPath, scale, noiseLevel = 0, outputFormat = "png", modelPath = null }) {
  return [
    "-i",
    inputPath,
    "-o",
    outputPath,
    "-s",
    String(scale),
    "-n",
    String(noiseLevel),
    ...(modelPath ? ["-m", modelPath] : []),
    "-f",
    outputFormat
  ];
}

function normalizeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  return raw.trim().split("\n")[0] || "unknown error";
}

function withMacosRealEsrganHint(message) {
  if (process.platform !== "darwin") {
    return message;
  }
  return `${message}; macOS tip: verify the managed AI upscalers can start in Terminal and Vulkan/MoltenVK support is available`;
}

function getVideoFrameRate(videoStream) {
  const candidate = videoStream?.avg_frame_rate && videoStream.avg_frame_rate !== "0/0" ? videoStream.avg_frame_rate : videoStream?.r_frame_rate;
  return candidate && candidate !== "0/0" ? candidate : "30/1";
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

class ManualClassificationRequiredError extends Error {
  constructor(details) {
    super(details.message);
    this.name = "ManualClassificationRequiredError";
    this.code = "MANUAL_CLASSIFICATION_REQUIRED";
    this.details = details;
  }
}

function buildManualScores(category) {
  return Object.fromEntries(
    VISUAL_CLASSIFICATION_CATEGORIES.map((label) => [label, label === category ? 1 : 0])
  );
}

function rankScores(scores = {}) {
  return Object.entries(scores).sort((left, right) => right[1] - left[1]);
}

function getClassificationMargin(classification) {
  const ranked = rankScores(classification?.scores || {});
  const top = ranked[0]?.[1] ?? classification?.confidence ?? 0;
  const runnerUp = ranked[1]?.[1] ?? 0;
  return top - runnerUp;
}

function getRoutingThreshold(provider, category) {
  const family = ROUTER_THRESHOLDS[provider] || ROUTER_THRESHOLDS.distilled;
  return family[category] || family.photo || { confidence: ROUTER_CONFIDENCE_THRESHOLD, margin: 0.05 };
}

function classificationPassesGate(classification, provider = classification?.provider || "distilled") {
  if (!classification?.category) {
    return false;
  }
  const threshold = getRoutingThreshold(provider, classification.category);
  return classification.confidence >= threshold.confidence && getClassificationMargin(classification) >= threshold.margin;
}

function mergeScores(left = {}, right = {}) {
  const labels = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries(
    [...labels].map((label) => [label, ((left[label] || 0) + (right[label] || 0)) / 2])
  );
}

function buildConsensusClassification(distilled, clip) {
  if (!distilled?.category || !clip?.category || distilled.category !== clip.category) {
    return null;
  }

  const mergedScores = mergeScores(distilled.scores, clip.scores);
  const merged = {
    category: distilled.category,
    confidence: Math.max(distilled.confidence, clip.confidence, (distilled.confidence + clip.confidence) / 2 + 0.08),
    scores: mergedScores,
    provider: "distilled+clip"
  };

  return classificationPassesGate(merged, "consensus") ? merged : null;
}

function summarizeClassification(providerLabel, classification) {
  if (!classification) {
    return `${providerLabel} unavailable`;
  }
  return `${providerLabel} suggested ${classification.category} at ${formatConfidence(classification.confidence)}`;
}

function buildAutomaticFailureMessage(distilled, clip, clipAttempted) {
  const summaryParts = [summarizeClassification("distilled", distilled)];
  if (clipAttempted) {
    summaryParts.push(summarizeClassification("CLIP fallback", clip));
  } else {
    summaryParts.push("CLIP fallback not needed");
  }

  if (!distilled && !clip) {
    return {
      failureCode: "model_unavailable",
      message: `Automatic content routing failed because no classifier was available (${summaryParts.join("; ")}).`
    };
  }

  if (distilled && clip && distilled.category !== clip.category) {
    return {
      failureCode: "low_confidence",
      message: `Automatic content routing failed because the distilled router and CLIP fallback disagreed (${summaryParts.join("; ")}).`
    };
  }

  return {
    failureCode: "low_confidence",
    message: `Automatic content routing failed because the classifiers were not confident enough (${summaryParts.join("; ")}).`
  };
}

async function shouldSecondGuessDistilledClassification(filePath, distilledClassification) {
  if (!distilledClassification?.category) {
    return true;
  }

  if (distilledClassification.category !== "portrait") {
    return !classificationPassesGate(distilledClassification, "distilled");
  }

  try {
    const features = await extractVisualFeatures(filePath);
    const suspiciousWidePortrait =
      features.aspectRatio >= 1.25 &&
      features.skinRatio < 0.14 &&
      (features.natureRatio >= 0.18 || features.flatRatio >= 0.36);
    return suspiciousWidePortrait;
  } catch (_error) {
    return !classificationPassesGate(distilledClassification, "distilled");
  }
}

function createManualClassification(category) {
  if (!VISUAL_CLASSIFICATION_CATEGORIES.includes(category)) {
    throw new Error(`Unsupported manual classification category: ${category}`);
  }

  return {
    category,
    confidence: 1,
    provider: "manual",
    scores: buildManualScores(category)
  };
}

async function attemptAutomaticClassification(filePath, capabilities = {}) {
  let distilledClassification = null;
  try {
    distilledClassification = await classifyImageWithDistilledModel(filePath, capabilities);
  } catch (error) {
    distilledClassification = {
      category: null,
      confidence: 0,
      scores: {},
      provider: "distilled-error",
      error: normalizeErrorMessage(error)
    };
  }

  const shouldEscalateToClip = await shouldSecondGuessDistilledClassification(filePath, distilledClassification);

  if (distilledClassification?.category && classificationPassesGate(distilledClassification, "distilled") && !shouldEscalateToClip) {
    return {
      ok: true,
      classification: distilledClassification
    };
  }

  let clipClassification = null;
  let clipAttempted = false;
  if (!distilledClassification?.category || !classificationPassesGate(distilledClassification, "distilled") || shouldEscalateToClip) {
    clipAttempted = true;
    try {
      clipClassification = await classifyImageWithClip(filePath);
    } catch (_error) {
      clipClassification = null;
    }
  }

  const consensus = buildConsensusClassification(
    distilledClassification?.category ? distilledClassification : null,
    clipClassification?.category ? clipClassification : null
  );
  if (consensus) {
    return {
      ok: true,
      classification: consensus
    };
  }

  if (clipClassification?.category && classificationPassesGate(clipClassification, "clip")) {
    return {
      ok: true,
      classification: clipClassification
    };
  }

  if (distilledClassification?.category && clipClassification?.category && distilledClassification.category === "photo" && clipClassification.category !== "photo" && classificationPassesGate(clipClassification, "clip")) {
    return {
      ok: true,
      classification: clipClassification
    };
  }

  const distilledForFailure = distilledClassification?.category ? distilledClassification : null;
  const clipForFailure = clipClassification?.category ? clipClassification : null;
  const failure = buildAutomaticFailureMessage(distilledForFailure, clipForFailure, clipAttempted);

  return {
    ok: false,
    failureCode: failure.failureCode,
    message: failure.message,
    classification: consensus || clipForFailure || distilledForFailure || null
  };
}

async function resolveClassificationOrThrow(filePath, capabilities, mediaType, manualCategory = null) {
  if (manualCategory) {
    return createManualClassification(manualCategory);
  }

  const automatic = await attemptAutomaticClassification(filePath, capabilities);
  if (automatic.ok) {
    return automatic.classification;
  }

  throw new ManualClassificationRequiredError({
    mediaType,
    failureCode: automatic.failureCode,
    message: automatic.message,
    suggestedCategory: automatic.classification?.category ?? null,
    confidence: automatic.classification?.confidence ?? null,
    scores: automatic.classification?.scores ?? null
  });
}

function formatConfidence(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function formatClassifierSummary(classification, mediaType) {
  if (classification?.provider === "manual") {
    return `manually classified ${mediaType} as ${classification.category}`;
  }
  const provider = classification?.provider ? ` via ${classification.provider.toUpperCase()}` : "";
  return `auto-classified ${mediaType} as ${classification.category} (${formatConfidence(classification.confidence)})${provider}`;
}

function canGenerateImageDerivative(preferences, capabilities, extension, isAnimated) {
  if (isAnimated || BAD_IMAGE_TRANSCODE_EXTENSIONS.has(extension)) {
    return false;
  }
  if (!capabilities?.cjxl?.available) {
    return false;
  }
  if (preferences.optimizationMode === "lossless" && LIKELY_LOSSY_IMAGE_EXTENSIONS.has(extension)) {
    return false;
  }
  return true;
}

function buildAutomaticUpscaleProfiles(category, mediaType) {
  if (mediaType === "video") {
    if (category === "anime" || category === "illustration") {
      return [
        {
          engine: "realEsrgan",
          modelName: "realesr-animevideov3",
          supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
          label: "Real-ESRGAN AnimeVideo-v3",
          modelDirectoryName: "models"
        }
      ];
    }

    return [
      {
        engine: "realEsrgan",
        modelName: "realesrgan-x4plus",
        supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
        label: "Real-ESRGAN x4plus",
        modelDirectoryName: "models"
      }
    ];
  }

  if (category === "anime") {
    return [
      {
        engine: "realCugan",
        supportedFactors: REAL_CUGAN_SCALE_FACTORS,
        label: "Real-CUGAN",
        noiseLevel: -1,
        modelDirectoryName: "models-se"
      },
      {
        engine: "waifu2x",
        supportedFactors: WAIFU2X_SCALE_FACTORS,
        label: "waifu2x",
        noiseLevel: 0,
        modelDirectoryName: "models-cunet"
      },
      {
        engine: "realEsrgan",
        modelName: "realesrgan-x4plus-anime",
        supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
        label: "Real-ESRGAN anime",
        modelDirectoryName: "models"
      }
    ];
  }

  if (category === "illustration") {
    return [
      {
        engine: "waifu2x",
        supportedFactors: WAIFU2X_SCALE_FACTORS,
        label: "waifu2x",
        noiseLevel: -1,
        modelDirectoryName: "models-cunet"
      },
      {
        engine: "realCugan",
        supportedFactors: REAL_CUGAN_SCALE_FACTORS,
        label: "Real-CUGAN",
        noiseLevel: -1,
        modelDirectoryName: "models-se"
      },
      {
        engine: "realEsrgan",
        modelName: "realesrgan-x4plus-anime",
        supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
        label: "Real-ESRGAN anime",
        modelDirectoryName: "models"
      }
    ];
  }

  if (category === "portrait") {
    return [
      {
        engine: "realEsrgan",
        modelName: "realesrnet-x4plus",
        supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
        label: "Real-ESRGAN net",
        modelDirectoryName: "models"
      },
      {
        engine: "realEsrgan",
        modelName: "realesrgan-x4plus",
        supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
        label: "Real-ESRGAN x4plus",
        modelDirectoryName: "models"
      }
    ];
  }

  return [
    {
      engine: "realEsrgan",
      modelName: "realesrgan-x4plus",
      supportedFactors: REAL_ESRGAN_SCALE_FACTORS,
      label: "Real-ESRGAN x4plus",
      modelDirectoryName: "models"
    }
  ];
}

function resolveUpscalerCommand(engine, capabilities) {
  if (engine === "realEsrgan") {
    return capabilities?.realEsrgan?.available ? getAvailableCommand(capabilities.realEsrgan, REAL_ESRGAN_COMMANDS) : null;
  }
  if (engine === "realCugan") {
    return capabilities?.realCugan?.available ? getAvailableCommand(capabilities.realCugan, REAL_CUGAN_COMMANDS) : null;
  }
  if (engine === "waifu2x") {
    return capabilities?.waifu2x?.available ? getAvailableCommand(capabilities.waifu2x, WAIFU2X_COMMANDS) : null;
  }
  return null;
}

function resolveModelPath(commandPath, directoryName) {
  if (!commandPath || !path.isAbsolute(commandPath) || !directoryName) {
    return null;
  }
  return path.join(path.dirname(commandPath), directoryName);
}

function buildUpscalerArgs(profile, commandPath, inputPath, outputPath, scale) {
  const modelPath = resolveModelPath(commandPath, profile.modelDirectoryName);

  if (profile.engine === "realEsrgan") {
    return buildRealEsrganArgs({
      inputPath,
      outputPath,
      scale,
      modelName: profile.modelName,
      modelPath
    });
  }
  if (profile.engine === "realCugan") {
    return buildRealCuganArgs({
      inputPath,
      outputPath,
      scale,
      noiseLevel: profile.noiseLevel ?? -1,
      modelPath
    });
  }
  if (profile.engine === "waifu2x") {
    return buildWaifu2xArgs({
      inputPath,
      outputPath,
      scale,
      noiseLevel: profile.noiseLevel ?? 0,
      modelPath
    });
  }
  throw new Error(`Unsupported upscaler engine: ${profile.engine}`);
}

async function spawnCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString() || `${command} failed`));
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

async function detectAv1Encoder() {
  if (!ffmpegStatic) {
    return null;
  }

  try {
    const output = await spawnCapture(ffmpegStatic, ["-hide_banner", "-encoders"]);
    if (output.includes("libsvtav1")) {
      return "libsvtav1";
    }
    if (output.includes("libaom-av1")) {
      return "libaom-av1";
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function isLosslessCodec(codecName) {
  return ["ffv1", "huffyuv", "utvideo", "rawvideo", "png", "ffvhuff"].includes((codecName || "").toLowerCase());
}

async function runAutomaticUpscale(inputPath, outputPath, classification, mediaType, targetHeight, sourceWidth, sourceHeight, capabilities) {
  const profiles = buildAutomaticUpscaleProfiles(classification.category, mediaType);
  const failures = [];

  for (const profile of profiles) {
    const commandPath = resolveUpscalerCommand(profile.engine, capabilities);
    if (!commandPath) {
      failures.push(`${profile.label} unavailable`);
      continue;
    }

    const scale = selectUpscaleFactor(sourceWidth, sourceHeight, targetHeight, profile.supportedFactors);
    if (!scale) {
      return {
        ok: false,
        skipped: true,
        reason: "no upscaling required"
      };
    }

    try {
      await spawnCapture(commandPath, buildUpscalerArgs(profile, commandPath, inputPath, outputPath, scale));
      return {
        ok: true,
        profile,
        scale
      };
    } catch (error) {
      failures.push(`${profile.label} failed (${normalizeErrorMessage(error)})`);
    }
  }

  return {
    ok: false,
    skipped: false,
    reason: failures.join("; ") || "no compatible upscaler was available"
  };
}

async function extractVideoClassificationFrame(filePath, workDir) {
  const framePath = path.join(workDir, `${uuid()}-classify.png`);
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    filePath,
    "-frames:v",
    "1",
    framePath
  ]);
  return framePath;
}

async function upscaleImageSource(filePath, metadata, dimensions, capabilities, workDir, manualCategory = null) {
  if (!shouldUpscaleToTarget(metadata.width, metadata.height, dimensions.targetHeight)) {
    return {
      path: filePath,
      actions: []
    };
  }

  const classification = await resolveClassificationOrThrow(filePath, capabilities, "image", manualCategory);
  const aiOutputPath = path.join(workDir, `${uuid()}-realesrgan.png`);
  const finalOutputPath = path.join(workDir, `${uuid()}-realesrgan-target.png`);

  try {
    const result = await runAutomaticUpscale(
      filePath,
      aiOutputPath,
      classification,
      "image",
      dimensions.targetHeight,
      metadata.width,
      metadata.height,
      capabilities
    );

    if (!result.ok) {
      return {
        path: filePath,
        actions: [
          formatClassifierSummary(classification, "image"),
          withMacosRealEsrganHint(`skipped image upscaling because ${result.reason}`)
        ]
      };
    }

    await sharp(aiOutputPath)
      .resize({
        width: dimensions.width,
        height: dimensions.height,
        fit: "inside",
        withoutEnlargement: false
      })
      .png()
      .toFile(finalOutputPath);

    return {
      path: finalOutputPath,
      actions: [
        formatClassifierSummary(classification, "image"),
        `upscaled via ${result.profile.label} ${result.scale}x and fit to ${dimensions.width}x${dimensions.height}`
      ]
    };
  } catch (error) {
    return {
      path: filePath,
      actions: [
        formatClassifierSummary(classification, "image"),
        withMacosRealEsrganHint(`skipped image upscaling because automatic routing failed (${normalizeErrorMessage(error)})`)
      ]
    };
  }
}

async function createAiUpscaledVideoDerivative(filePath, videoStream, dimensions, capabilities, workDir, encoder, manualCategory = null) {
  const extractedFramesDir = path.join(workDir, `${uuid()}-frames-in`);
  const upscaledFramesDir = path.join(workDir, `${uuid()}-frames-out`);
  const outputPath = path.join(workDir, `${uuid()}.mkv`);
  await fs.mkdir(extractedFramesDir, { recursive: true });
  await fs.mkdir(upscaledFramesDir, { recursive: true });

  try {
    const framePath = await extractVideoClassificationFrame(filePath, workDir);
    const classification = await resolveClassificationOrThrow(framePath, capabilities, "video", manualCategory);

    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vsync",
      "0",
      path.join(extractedFramesDir, VIDEO_FRAME_PATTERN)
    ]);

    const result = await runAutomaticUpscale(
      extractedFramesDir,
      upscaledFramesDir,
      classification,
      "video",
      dimensions.targetHeight,
      videoStream?.width,
      videoStream?.height,
      capabilities
    );
    if (!result.ok) {
      return {
        error: result.reason,
        classification
      };
    }

    const filters = [`scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease`];
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      getVideoFrameRate(videoStream),
      "-i",
      path.join(upscaledFramesDir, VIDEO_FRAME_PATTERN),
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-map",
      "1:a?",
      "-map",
      "1:s?",
      "-vf",
      filters.join(","),
      "-c:v",
      encoder,
      ...(encoder === "libsvtav1" ? ["-crf", "28", "-preset", "5"] : ["-crf", "30", "-cpu-used", "4"]),
      "-c:a",
      "copy",
      "-c:s",
      "copy",
      outputPath
    ]);

    return {
      derivative: {
        label: "optimized_access_av1",
        path: outputPath,
        extension: ".mkv",
        mime: "video/x-matroska",
        actions: [`generated AV1 access copy from ${result.profile.label}-upscaled frames`]
      },
      actions: [
        formatClassifierSummary(classification, "video"),
        `upscaled video frames via ${result.profile.label} ${result.scale}x before AV1 encoding`
      ]
    };
  } catch (error) {
    return {
      error: `automatic upscaling failed (${normalizeErrorMessage(error)})`
    };
  }
}

async function optimizeImage(filePath, preferences, capabilities, workDir, manualCategory = null) {
  const safeCapabilities = capabilities || {};
  const metadata = await sharp(filePath, { animated: true }).metadata();
  const actions = [];
  const extension = extname(filePath);
  const dimensions = resolveTierDimensions(metadata.width || 0, metadata.height || 0, preferences.imageTargetResolution);
  const isAnimated = (metadata.pages || 1) > 1;

  let derivative = null;
  if (isAnimated || BAD_IMAGE_TRANSCODE_EXTENSIONS.has(extension)) {
    actions.push("preserved original because this image format is not eligible for derivative transcoding");
  } else if (!safeCapabilities.cjxl?.available) {
    actions.push("no JPEG XL derivative created");
  } else {
    const mathematicallyLosslessSource = LOSSLESS_IMAGE_EXTENSIONS.has(extension);
    const likelyLossySource = LIKELY_LOSSY_IMAGE_EXTENSIONS.has(extension);

    if (preferences.optimizationMode === "lossless" && likelyLossySource) {
      actions.push("preserved original because source is already lossy");
    } else {
      const intermediatePngPath = path.join(workDir, `${uuid()}.png`);
      const outputJxlPath = path.join(workDir, `${uuid()}.jxl`);
      const upscaleResult =
        preferences.upscaleEnabled && metadata.width && metadata.height
          ? await upscaleImageSource(filePath, metadata, dimensions, safeCapabilities, workDir, manualCategory)
          : { path: filePath, actions: [] };
      let derivativePipeline = sharp(upscaleResult.path);
      actions.push(...upscaleResult.actions);

      if (!preferences.stripDerivativeMetadata) {
        derivativePipeline = derivativePipeline.withMetadata();
      }

      await derivativePipeline.png().toFile(intermediatePngPath);
      const cjxlArgs =
        preferences.optimizationMode === "lossless" && mathematicallyLosslessSource
          ? [intermediatePngPath, outputJxlPath, "--effort=7", "--lossless_jpeg=0", "--modular=1"]
          : [intermediatePngPath, outputJxlPath, "--effort=7", "--distance=1.0"];
      await spawnCapture("cjxl", cjxlArgs);

      derivative = {
        label: preferences.optimizationMode === "lossless" ? "optimized_lossless" : "optimized_visual",
        path: outputJxlPath,
        extension: ".jxl",
        mime: "image/jxl",
        actions: [
          preferences.optimizationMode === "lossless" && mathematicallyLosslessSource
            ? "transcoded to JPEG XL lossless"
            : "transcoded to JPEG XL visually lossless"
        ]
      };
    }
  }

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
    derivative,
    actions,
    summary: `${metadata.width || "?"}x${metadata.height || "?"}, nearest tier ${dimensions.nearestTier}`
  };
}

async function optimizeVideo(filePath, preferences, capabilities, workDir, manualCategory = null) {
  const safeCapabilities = capabilities || {};
  const probe = await getVideoProbe(filePath);
  const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
  const actions = [];
  const originalExtension = extname(filePath);
  const dimensions = resolveTierDimensions(videoStream?.width || 0, videoStream?.height || 0, preferences.videoTargetResolution);

  let derivative = null;
  const sourceLossless = isLosslessCodec(videoStream?.codec_name);
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
  } else if (safeCapabilities.av1Encoder?.value) {
    const encoder = safeCapabilities.av1Encoder.value;
    const wantsUpscale = preferences.upscaleEnabled && shouldUpscaleToTarget(videoStream?.width, videoStream?.height, dimensions.targetHeight);
    if (wantsUpscale) {
      const aiDerivative = await createAiUpscaledVideoDerivative(filePath, videoStream, dimensions, safeCapabilities, workDir, encoder, manualCategory);
      if (aiDerivative?.derivative) {
        derivative = aiDerivative.derivative;
        actions.push(...aiDerivative.actions);
      } else if (aiDerivative?.error) {
        if (aiDerivative.classification?.category) {
          actions.push(formatClassifierSummary(aiDerivative.classification, "video"));
        }
        actions.push(withMacosRealEsrganHint(`skipped video upscaling because ${aiDerivative.error}`));
      }
    }

    if (!derivative) {
      const outputPath = path.join(workDir, `${uuid()}.mkv`);
      await runFfmpeg([
        "-y",
        "-i",
        filePath,
        "-map",
        "0",
        "-c:v",
        encoder,
        ...(encoder === "libsvtav1" ? ["-crf", "28", "-preset", "5"] : ["-crf", "30", "-cpu-used", "4"]),
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
    }
  } else {
    actions.push("AV1 encoder unavailable in ffmpeg build");
  }

  return {
    kind: "video",
    original: {
      path: filePath,
      extension: originalExtension,
      mime: fileDisplayType(filePath),
      width: videoStream?.width || null,
      height: videoStream?.height || null,
      codec: videoStream?.codec_name || null
    },
    derivative,
    actions,
    summary: `${videoStream?.codec_name || "unknown"} ${videoStream?.width || "?"}x${videoStream?.height || "?"}, nearest tier ${dimensions.nearestTier}`
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

async function analyzePath(filePath, preferences, capabilities, workDir, options = {}) {
  const normalizedPreferences = {
    ...preferences,
    optimizationMode:
      preferences.optimizationMode === "pick_per_file" ? "visually_lossless" : preferences.optimizationMode
  };
  const manualCategory = options.manualClassification ?? null;
  const kind = classifyPath(filePath);
  if (kind === "image") {
    return optimizeImage(filePath, normalizedPreferences, capabilities, workDir, manualCategory);
  }
  if (kind === "video") {
    return optimizeVideo(filePath, normalizedPreferences, capabilities, workDir, manualCategory);
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
    summary: "generic file"
  };
}

async function inspectManualClassificationRequirement(filePath, preferences, capabilities, workDir, manualCategory = null) {
  const normalizedPreferences = {
    ...preferences,
    optimizationMode:
      preferences.optimizationMode === "pick_per_file" ? "visually_lossless" : preferences.optimizationMode
  };
  const kind = classifyPath(filePath);
  if (manualCategory || !normalizedPreferences.upscaleEnabled) {
    return null;
  }

  if (kind === "image") {
    const metadata = await sharp(filePath, { animated: true }).metadata();
    const extension = extname(filePath);
    const isAnimated = (metadata.pages || 1) > 1;
    const dimensions = resolveTierDimensions(metadata.width || 0, metadata.height || 0, normalizedPreferences.imageTargetResolution);
    if (!canGenerateImageDerivative(normalizedPreferences, capabilities, extension, isAnimated)) {
      return null;
    }
    if (!shouldUpscaleToTarget(metadata.width, metadata.height, dimensions.targetHeight)) {
      return null;
    }

    const automatic = await attemptAutomaticClassification(filePath, capabilities);
    if (automatic.ok) {
      return null;
    }

    return {
      mediaType: "image",
      ...automatic,
      suggestedCategory: automatic.classification?.category ?? null
    };
  }

  if (kind === "video") {
    if (normalizedPreferences.optimizationMode === "lossless" || !capabilities?.av1Encoder?.value) {
      return null;
    }

    const probe = await getVideoProbe(filePath);
    const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
    const dimensions = resolveTierDimensions(videoStream?.width || 0, videoStream?.height || 0, normalizedPreferences.videoTargetResolution);
    if (!shouldUpscaleToTarget(videoStream?.width, videoStream?.height, dimensions.targetHeight)) {
      return null;
    }

    const framePath = await extractVideoClassificationFrame(filePath, workDir);
    const automatic = await attemptAutomaticClassification(framePath, capabilities);
    if (automatic.ok) {
      return null;
    }

    return {
      mediaType: "video",
      ...automatic,
      suggestedCategory: automatic.classification?.category ?? null
    };
  }

  return null;
}

module.exports = {
  ManualClassificationRequiredError,
  analyzePath,
  attemptAutomaticClassification,
  buildRealEsrganArgs,
  buildRealCuganArgs,
  buildWaifu2xArgs,
  buildAutomaticUpscaleProfiles,
  classifyPath,
  detectAv1Encoder,
  generatePreviewFile,
  inspectManualClassificationRequirement,
  selectUpscaleFactor,
  shouldUpscaleToTarget,
  VISUAL_CLASSIFICATION_CATEGORIES
};
