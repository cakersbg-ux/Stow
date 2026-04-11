const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sharp = require("sharp");
const mime = require("mime-types");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { v4: uuid } = require("uuid");
const { classifyImageWithDistilledModel } = require("./distilledClassifier");
const { getUpscaleRouteLabel, normalizeUpscaleRoute, UPSCALE_ROUTES } = require("./upscaleRoutes");

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
const VIDEO_INTERPOLATION_FRAME_TARGETS = new Set(["off", "30", "60", "120"]);
const VIDEO_FRAME_PATTERN = "frame-%08d.png";

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
  return `${message}; macOS tip: verify the managed AI upscaler runs from its install folder in Terminal and that Vulkan/MoltenVK support is available`;
}

function getVideoFrameRate(videoStream) {
  const candidate = videoStream?.avg_frame_rate && videoStream.avg_frame_rate !== "0/0" ? videoStream.avg_frame_rate : videoStream?.r_frame_rate;
  return candidate && candidate !== "0/0" ? candidate : "30/1";
}

function parseFrameRate(frameRate) {
  if (typeof frameRate !== "string") {
    return null;
  }
  const trimmed = frameRate.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("/")) {
    const [numeratorRaw, denominatorRaw] = trimmed.split("/");
    const numerator = Number.parseFloat(numeratorRaw);
    const denominator = Number.parseFloat(denominatorRaw);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return null;
    }
    const value = numerator / denominator;
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatFps(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "unknown";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function ensureEven(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 0));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

function normalizeVideoDimensions(dimensions) {
  return {
    ...dimensions,
    width: ensureEven(dimensions.width),
    height: ensureEven(dimensions.height),
    targetHeight: ensureEven(dimensions.targetHeight)
  };
}

function normalizeVideoInterpolationFrameTarget(value) {
  if (typeof value !== "string") {
    return "off";
  }
  return VIDEO_INTERPOLATION_FRAME_TARGETS.has(value) ? value : "off";
}

function resolveInterpolationTargetFps(videoStream, interpolationFrameTarget) {
  const normalizedTarget = normalizeVideoInterpolationFrameTarget(interpolationFrameTarget);
  if (normalizedTarget === "off") {
    return null;
  }

  const targetFps = Number.parseInt(normalizedTarget, 10);
  if (!Number.isFinite(targetFps) || targetFps <= 0) {
    return null;
  }

  const sourceFps = parseFrameRate(getVideoFrameRate(videoStream)) ?? 30;
  return targetFps > sourceFps + 0.01 ? targetFps : null;
}

function buildVideoFilterChain(dimensions, interpolationTargetFps = null, applySpatialUpscale = true) {
  const filters = [];

  if (applySpatialUpscale) {
    filters.push(`scale=${dimensions.width}:${dimensions.height}:flags=lanczos+accurate_rnd+full_chroma_int:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  }

  if (interpolationTargetFps) {
    filters.push(`minterpolate=fps=${interpolationTargetFps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
  }

  if (filters.length > 0) {
    filters.push("format=yuv420p");
  }
  return filters;
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

class ManualRoutingRequiredError extends Error {
  constructor(details) {
    super(details.message);
    this.name = "ManualRoutingRequiredError";
    this.code = "MANUAL_ROUTING_REQUIRED";
    this.details = details;
  }
}

function buildManualScores(route) {
  return Object.fromEntries(UPSCALE_ROUTES.map((label) => [label, label === route ? 1 : 0]));
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

function summarizeClassification(providerLabel, classification) {
  if (!classification) {
    return `${providerLabel} unavailable`;
  }
  return `${providerLabel} suggested ${getUpscaleRouteLabel(classification.route)} at ${formatConfidence(classification.confidence)}`;
}

function buildAutomaticFailureMessage(distilled) {
  const summary = summarizeClassification("Stout", distilled);
  if (!distilled) {
    return {
      failureCode: "model_unavailable",
      message: `Automatic content routing failed because Stout was unavailable (${summary}).`
    };
  }

  return {
    failureCode: "runtime_error",
    message: `Automatic content routing failed because Stout could not produce a trustworthy route (${summary}).`
  };
}

function createManualRouting(route) {
  const normalizedRoute = normalizeUpscaleRoute(route);
  if (!normalizedRoute) {
    throw new Error(`Unsupported manual route: ${route}`);
  }

  return {
    route: normalizedRoute,
    confidence: 1,
    provider: "manual",
    accepted: true,
    scores: buildManualScores(normalizedRoute),
    alternatives: []
  };
}

async function attemptAutomaticClassification(filePath, capabilities = {}) {
  try {
    const distilledClassification = await classifyImageWithDistilledModel(filePath, capabilities);
    if (distilledClassification?.route && distilledClassification.accepted) {
      return {
        ok: true,
        classification: distilledClassification
      };
    }

    const failure = buildAutomaticFailureMessage(distilledClassification?.route ? distilledClassification : null);
    return {
      ok: false,
      failureCode: failure.failureCode,
      message: failure.message,
      classification: distilledClassification?.route ? distilledClassification : null
    };
  } catch (error) {
    return {
      ok: false,
      failureCode: "runtime_error",
      message: `Automatic content routing failed because Stout errored (${normalizeErrorMessage(error)}).`,
      classification: null
    };
  }
}

async function resolveClassificationOrThrow(filePath, capabilities, mediaType, manualRoute = null) {
  if (manualRoute) {
    return createManualRouting(manualRoute);
  }

  const automatic = await attemptAutomaticClassification(filePath, capabilities);
  if (automatic.ok) {
    return automatic.classification;
  }

  throw new ManualRoutingRequiredError({
    mediaType,
    failureCode: automatic.failureCode,
    message: automatic.message,
    suggestedRoute: automatic.classification?.route ?? null,
    confidence: automatic.classification?.confidence ?? null,
    scores: automatic.classification?.scores ?? null,
    alternatives: automatic.classification?.alternatives ?? []
  });
}

function formatConfidence(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function formatClassifierSummary(classification, mediaType) {
  if (classification?.provider === "manual") {
    return `manually routed ${mediaType} as ${getUpscaleRouteLabel(classification.route)}`;
  }
  const provider = classification?.provider ? ` via ${classification.provider.toUpperCase()}` : "";
  return `auto-routed ${mediaType} as ${getUpscaleRouteLabel(classification.route)} (${formatConfidence(classification.confidence)})${provider}`;
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

function buildAutomaticUpscaleProfiles(route, mediaType) {
  if (mediaType === "video") {
    if (route === "art_anime" || route === "art_clean") {
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

  if (route === "art_anime") {
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

  if (route === "art_clean") {
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

  if (route === "text_ui") {
    return [
      {
        engine: "waifu2x",
        supportedFactors: WAIFU2X_SCALE_FACTORS,
        label: "waifu2x",
        noiseLevel: 0,
        modelDirectoryName: "models-cunet"
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

  if (route === "photo_gentle") {
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
        reject(
          new Error(
            stderrText ||
              stdoutText ||
              `${command} exited with code ${code ?? "unknown"}`
          )
        );
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

function buildJxlEncodeArgs(inputPath, outputPath, options = {}) {
  const inputExtension = extname(inputPath);
  const {
    effort = 7,
    visuallyLosslessDistance = 1.0,
    mathematicallyLossless = false
  } = options;

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

async function runAutomaticUpscale(inputPath, outputPath, classification, mediaType, targetHeight, sourceWidth, sourceHeight, capabilities) {
  const profiles = buildAutomaticUpscaleProfiles(classification.route, mediaType);
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
      await spawnCapture(commandPath, buildUpscalerArgs(profile, commandPath, inputPath, outputPath, scale), {
        cwd: path.dirname(commandPath)
      });
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

async function upscaleImageSource(filePath, metadata, dimensions, capabilities, workDir, manualRoute = null) {
  if (!shouldUpscaleToTarget(metadata.width, metadata.height, dimensions.targetHeight)) {
    return {
      path: filePath,
      actions: []
    };
  }

  const classification = await resolveClassificationOrThrow(filePath, capabilities, "image", manualRoute);
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
        routing: classification,
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
      routing: classification,
      actions: [
        formatClassifierSummary(classification, "image"),
        `upscaled via ${result.profile.label} ${result.scale}x and fit to ${dimensions.width}x${dimensions.height}`
      ]
    };
  } catch (error) {
    return {
      path: filePath,
      routing: classification,
      actions: [
        formatClassifierSummary(classification, "image"),
        withMacosRealEsrganHint(`skipped image upscaling because automatic routing failed (${normalizeErrorMessage(error)})`)
      ]
    };
  }
}

async function createAiUpscaledVideoDerivative(
  filePath,
  videoStream,
  dimensions,
  capabilities,
  workDir,
  encoder,
  interpolationTargetFps = null,
  manualRoute = null
) {
  const extractedFramesDir = path.join(workDir, `${uuid()}-frames-in`);
  const upscaledFramesDir = path.join(workDir, `${uuid()}-frames-out`);
  const outputPath = path.join(workDir, `${uuid()}.mkv`);
  await fs.mkdir(extractedFramesDir, { recursive: true });
  await fs.mkdir(upscaledFramesDir, { recursive: true });

  try {
    const framePath = await extractVideoClassificationFrame(filePath, workDir);
    const classification = await resolveClassificationOrThrow(framePath, capabilities, "video", manualRoute);

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

    const filters = buildVideoFilterChain(dimensions, interpolationTargetFps);
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
        actions: [
          `generated AV1 access copy from ${result.profile.label}-upscaled frames`,
          ...(interpolationTargetFps
            ? [`interpolated to ${formatFps(interpolationTargetFps)} fps with motion-compensated interpolation`]
            : [])
        ]
      },
      routing: classification,
      actions: [
        formatClassifierSummary(classification, "video"),
        `upscaled video frames via ${result.profile.label} ${result.scale}x before AV1 encoding`,
        ...(interpolationTargetFps
          ? [`interpolated to ${formatFps(interpolationTargetFps)} fps with motion-compensated interpolation`]
          : [])
      ]
    };
  } catch (error) {
    return {
      error: `automatic upscaling failed (${normalizeErrorMessage(error)})`
    };
  }
}

async function optimizeImage(filePath, preferences, capabilities, workDir, manualRoute = null) {
  const safeCapabilities = capabilities || {};
  const metadata = await sharp(filePath, { animated: true }).metadata();
  const actions = [];
  const extension = extname(filePath);
  const dimensions = resolveTierDimensions(metadata.width || 0, metadata.height || 0, preferences.imageTargetResolution);
  const isAnimated = (metadata.pages || 1) > 1;

  let derivative = null;
  let previewSourcePath = filePath;
  let routing = null;
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
      const outputJxlPath = path.join(workDir, `${uuid()}.jxl`);
      const upscaleResult =
        preferences.upscaleEnabled && metadata.width && metadata.height
          ? await upscaleImageSource(filePath, metadata, dimensions, safeCapabilities, workDir, manualRoute)
          : { path: filePath, actions: [], routing: null };
      previewSourcePath = upscaleResult.path || filePath;
      routing = upscaleResult.routing ?? routing;
      actions.push(...upscaleResult.actions);
      const canEncodeDirectly = canUseDirectJxlInput(upscaleResult.path, preferences.stripDerivativeMetadata);
      let encodeInputPath = upscaleResult.path;

      if (!canEncodeDirectly) {
        const intermediatePngPath = path.join(workDir, `${uuid()}.png`);
        let derivativePipeline = sharp(upscaleResult.path);
        if (!preferences.stripDerivativeMetadata) {
          derivativePipeline = derivativePipeline.withMetadata();
        }
        await derivativePipeline.png().toFile(intermediatePngPath);
        encodeInputPath = intermediatePngPath;
      }

      await spawnCapture(
        "cjxl",
        buildJxlEncodeArgs(encodeInputPath, outputJxlPath, {
          mathematicallyLossless: preferences.optimizationMode === "lossless" && mathematicallyLosslessSource
        })
      );

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
    routing,
    actions,
    summary: `${metadata.width || "?"}x${metadata.height || "?"}, nearest tier ${dimensions.nearestTier}`,
    previewSourcePath
  };
}

async function optimizeVideo(filePath, preferences, capabilities, workDir, manualRoute = null) {
  const safeCapabilities = capabilities || {};
  const probe = await getVideoProbe(filePath);
  const videoStream = probe.streams.find((stream) => stream.codec_type === "video");
  const actions = [];
  const originalExtension = extname(filePath);
  const dimensions = normalizeVideoDimensions(
    resolveTierDimensions(videoStream?.width || 0, videoStream?.height || 0, preferences.videoTargetResolution)
  );
  const interpolationTargetFps = preferences.videoUpscaleEnabled
    ? resolveInterpolationTargetFps(videoStream, preferences.videoInterpolationFrameTarget)
    : null;

  let derivative = null;
  let routing = null;
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
    const wantsUpscale =
      preferences.videoUpscaleEnabled && shouldUpscaleToTarget(videoStream?.width, videoStream?.height, dimensions.targetHeight);
    if (wantsUpscale) {
      const aiDerivative = await createAiUpscaledVideoDerivative(
        filePath,
        videoStream,
        dimensions,
        safeCapabilities,
        workDir,
        encoder,
        interpolationTargetFps,
        manualRoute
      );
      if (aiDerivative?.derivative) {
        derivative = aiDerivative.derivative;
        routing = aiDerivative.routing ?? routing;
        actions.push(...aiDerivative.actions);
      } else if (aiDerivative?.error) {
        if (aiDerivative.classification?.route) {
          actions.push(formatClassifierSummary(aiDerivative.classification, "video"));
        }
        actions.push(withMacosRealEsrganHint(`skipped video upscaling because ${aiDerivative.error}`));
      }
    }

    if (!derivative) {
      const outputPath = path.join(workDir, `${uuid()}.mkv`);
      const filters = buildVideoFilterChain(dimensions, interpolationTargetFps, wantsUpscale);
      await runFfmpeg([
        "-y",
        "-i",
        filePath,
        "-map",
        "0",
        ...(filters.length ? ["-vf", filters.join(",")] : []),
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
        actions: [
          "generated AV1 access copy with audio and subtitle streams preserved",
          ...(wantsUpscale ? [`upscaled video to ${dimensions.width}x${dimensions.height} with high-quality scaling`] : []),
          ...(interpolationTargetFps
            ? [`interpolated to ${formatFps(interpolationTargetFps)} fps with motion-compensated interpolation`]
            : [])
        ]
      };
      if (wantsUpscale) {
        actions.push(`upscaled video to ${dimensions.width}x${dimensions.height} with high-quality scaling`);
      }
      if (interpolationTargetFps) {
        actions.push(`interpolated to ${formatFps(interpolationTargetFps)} fps with motion-compensated interpolation`);
      }
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
    routing,
    actions,
    summary: `${videoStream?.codec_name || "unknown"} ${videoStream?.width || "?"}x${videoStream?.height || "?"}, nearest tier ${dimensions.nearestTier}`,
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

async function analyzePath(filePath, preferences, capabilities, workDir, options = {}) {
  const normalizedPreferences = {
    ...preferences,
    videoUpscaleEnabled: preferences.videoUpscaleEnabled === true,
    videoInterpolationFrameTarget: normalizeVideoInterpolationFrameTarget(preferences.videoInterpolationFrameTarget),
    optimizationMode:
      preferences.optimizationMode === "pick_per_file" ? "visually_lossless" : preferences.optimizationMode
  };
  const manualRoute = options.manualRoute ?? options.manualClassification ?? null;
  const kind = classifyPath(filePath);
  if (kind === "image") {
    return optimizeImage(filePath, normalizedPreferences, capabilities, workDir, manualRoute);
  }
  if (kind === "video") {
    return optimizeVideo(filePath, normalizedPreferences, capabilities, workDir, manualRoute);
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
    routing: null,
    actions: ["stored as general file object"],
    summary: "generic file",
    previewSourcePath: null
  };
}

async function inspectManualRoutingRequirement(filePath, preferences, capabilities, workDir, manualRoute = null) {
  const normalizedPreferences = {
    ...preferences,
    videoUpscaleEnabled: preferences.videoUpscaleEnabled === true,
    videoInterpolationFrameTarget: normalizeVideoInterpolationFrameTarget(preferences.videoInterpolationFrameTarget),
    optimizationMode:
      preferences.optimizationMode === "pick_per_file" ? "visually_lossless" : preferences.optimizationMode
  };
  const kind = classifyPath(filePath);
  if (manualRoute || (!normalizedPreferences.upscaleEnabled && !normalizedPreferences.videoUpscaleEnabled)) {
    return null;
  }

  if (kind === "image") {
    if (!normalizedPreferences.upscaleEnabled) {
      return null;
    }
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
      suggestedRoute: automatic.classification?.route ?? null
    };
  }

  if (kind === "video") {
    if (normalizedPreferences.optimizationMode === "lossless" || !normalizedPreferences.videoUpscaleEnabled || !capabilities?.av1Encoder?.value) {
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
      suggestedRoute: automatic.classification?.route ?? null
    };
  }

  return null;
}

module.exports = {
  ManualRoutingRequiredError,
  analyzePath,
  attemptAutomaticClassification,
  buildRealEsrganArgs,
  buildRealCuganArgs,
  buildWaifu2xArgs,
  buildVideoFilterChain,
  buildAutomaticUpscaleProfiles,
  classifyPath,
  detectAv1Encoder,
  formatFps,
  generatePreviewFile,
  inspectManualRoutingRequirement,
  parseFrameRate,
  resolveInterpolationTargetFps,
  selectUpscaleFactor,
  shouldUpscaleToTarget,
  UPSCALE_ROUTES,
  getClassificationMargin
};
