const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mime = require("mime-types");
const { v4: uuid } = require("uuid");
const { resolveOptimizationTier } = require("./mediaTools");

const LOSSLESS_IMAGE_EXTENSIONS = new Set([".png", ".tif", ".tiff", ".bmp", ".jxl"]);
const LOSSY_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".webp", ".avif"]);
const ANIMATED_IMAGE_EXTENSIONS = new Set([".gif"]);
const LOSSLESS_VIDEO_CODECS = new Set(["ffv1", "huffyuv", "utvideo", "rawvideo", "png", "ffvhuff"]);
const LOSSLESS_AUDIO_EXTENSIONS = new Set([".wav", ".aif", ".aiff", ".flac", ".alac"]);
const LOSSY_AUDIO_EXTENSIONS = new Set([".mp3", ".aac", ".m4a", ".ogg", ".opus"]);

const TIER_RULES = {
  lossless: {
    imageWin: 0.01,
    videoWin: 0.01,
    audioWin: 0.01,
    quality: Infinity,
    allowedLossy: false
  },
  visually_lossless: {
    imageWin: 0.05,
    videoWin: 0.05,
    audioWin: 0.05,
    quality: 90,
    allowedLossy: true
  },
  lossy_balanced: {
    imageWin: 0.2,
    videoWin: 0.2,
    audioWin: 0.2,
    quality: 80,
    allowedLossy: true
  },
  lossy_aggressive: {
    imageWin: 0.35,
    videoWin: 0.35,
    audioWin: 0.35,
    quality: 65,
    allowedLossy: true
  }
};

function extname(filePath) {
  return path.extname(filePath).toLowerCase();
}

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

let sharpModule = null;
let sharpLoaded = false;
function getSharp() {
  if (!sharpLoaded) {
    sharpModule = loadOptionalModule("sharp");
    sharpLoaded = true;
  }
  return sharpModule;
}

let ffmpegStaticPath = null;
let ffmpegLoaded = false;
function getFfmpegStaticPath() {
  if (!ffmpegLoaded) {
    ffmpegStaticPath = loadOptionalModule("ffmpeg-static");
    ffmpegLoaded = true;
  }
  return ffmpegStaticPath;
}

let ffprobeStatic = null;
let ffprobeLoaded = false;
function getFfprobeStatic() {
  if (!ffprobeLoaded) {
    ffprobeStatic = loadOptionalModule("ffprobe-static");
    ffprobeLoaded = true;
  }
  return ffprobeStatic;
}

async function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : null;
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
          reject(new Error(Buffer.concat(stderr).toString() || Buffer.concat(stdout).toString() || `${command} exited with code ${code}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      })
    );

    if (timeoutMs) {
      timeoutId = setTimeout(() => {
        settle(() => {
          try {
            child.kill("SIGKILL");
          } catch (_error) {
            // Ignore termination failures; the timeout is authoritative.
          }
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
    }
  });
}

async function probeVideo(filePath) {
  const ffprobe = getFfprobeStatic();
  if (!ffprobe?.path) {
    return null;
  }

  const output = await spawnCapture(ffprobe.path, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    filePath
  ], {
    timeoutMs: 30_000
  });
  return JSON.parse(output);
}

function formatMime(filePath) {
  return mime.lookup(filePath) || "application/octet-stream";
}

function qualityThresholdForTier(tier) {
  return TIER_RULES[tier]?.quality ?? TIER_RULES.visually_lossless.quality;
}

function sizeWinForTier(tier, kind) {
  const tierRule = TIER_RULES[tier] || TIER_RULES.visually_lossless;
  if (kind === "video") {
    return tierRule.videoWin;
  }
  if (kind === "audio") {
    return tierRule.audioWin;
  }
  return tierRule.imageWin;
}

function isLosslessVideoCodec(codecName) {
  return LOSSLESS_VIDEO_CODECS.has((codecName || "").toLowerCase());
}

function estimateImageQuality(label, tier, options = {}) {
  const quality = typeof options.quality === "number" ? options.quality : null;
  const distance = typeof options.distance === "number" ? options.distance : null;
  if (label === "jxl") {
    if (distance === 0) {
      return 100;
    }
    if (distance === 1) {
      return 96;
    }
    if (distance <= 1.5) {
      return 92;
    }
    if (distance <= 2.5) {
      return 88;
    }
    return 80;
  }
  if (label === "avif") {
    if (quality >= 60) return 94;
    if (quality >= 50) return 90;
    if (quality >= 40) return 84;
    return 76;
  }
  if (label === "webp") {
    if (quality >= 82) return 90;
    if (quality >= 72) return 84;
    if (quality >= 60) return 76;
    return 68;
  }
  if (label === "jpeg") {
    if (quality >= 90) return 88;
    if (quality >= 82) return 82;
    if (quality >= 72) return 74;
    return 68;
  }
  if (label === "png") {
    return 100;
  }
  return qualityThresholdForTier(tier);
}

function estimateVideoQuality(label, tier, options = {}) {
  const crf = typeof options.crf === "number" ? options.crf : null;
  if (label === "ffv1") {
    return 100;
  }
  if (label === "av1") {
    if (crf <= 24) return 98;
    if (crf <= 28) return 95;
    if (crf <= 32) return 90;
    if (crf <= 36) return 84;
    return 75;
  }
  return qualityThresholdForTier(tier);
}

function estimateAudioQuality(label, tier, options = {}) {
  const bitrate = typeof options.bitrate === "number" ? options.bitrate : null;
  if (label === "flac") {
    return 100;
  }
  if (label === "opus") {
    if (bitrate >= 160_000) return 95;
    if (bitrate >= 128_000) return 90;
    if (bitrate >= 96_000) return 84;
    if (bitrate >= 64_000) return 76;
    return 68;
  }
  return qualityThresholdForTier(tier);
}

async function encodeImageCandidate(sourcePath, outputPath, candidate) {
  const sharp = getSharp();
  if (!sharp) {
    return false;
  }

  if (candidate.label === "jxl") {
    const cjxlCommand = candidate.command || "cjxl";
    await spawnCapture(cjxlCommand, [sourcePath, candidate.outputPath || outputPath, ...(candidate.args || [])], {
      timeoutMs: 120_000
    });
    return true;
  }

  let pipeline = sharp(sourcePath, { animated: candidate.animated === true });
  if (candidate.resize) {
    pipeline = pipeline.resize(candidate.resize);
  }
  if (candidate.label === "jpeg") {
    await pipeline.jpeg(candidate.options).toFile(outputPath);
    return true;
  }
  if (candidate.label === "webp") {
    await pipeline.webp(candidate.options).toFile(outputPath);
    return true;
  }
  if (candidate.label === "avif") {
    await pipeline.avif(candidate.options).toFile(outputPath);
    return true;
  }
  if (candidate.label === "png") {
    await pipeline.png(candidate.options).toFile(outputPath);
    return true;
  }

  return false;
}

async function encodeVideoCandidate(sourcePath, outputPath, candidate) {
  const ffmpegStatic = getFfmpegStaticPath();
  if (!ffmpegStatic) {
    return false;
  }

  await spawnCapture(ffmpegStatic, candidate.args.concat(outputPath), { timeoutMs: 120_000 });
  return true;
}

async function createImageCandidates(sourcePath, metadata, tier, capabilities, workDir) {
  const sharp = getSharp();
  if (!sharp) {
    return [];
  }

  const extension = extname(sourcePath);
  const outputBase = () => path.join(workDir, `${uuid()}`);
  const tierRule = TIER_RULES[tier] || TIER_RULES.visually_lossless;
  const candidates = [];
  const animated = Boolean(metadata.pages && metadata.pages > 1);
  const canEncodeAnimated = !animated || extension === ".gif";

  const pushCandidate = async (candidate) => {
    const outputPath = `${outputBase()}${candidate.extension}`;
    try {
      const encoded = await encodeImageCandidate(sourcePath, outputPath, candidate);
      if (!encoded) {
        return;
      }
      const stat = await fs.stat(outputPath);
      candidates.push({
        id: candidate.id,
        label: candidate.label,
        outputPath,
        path: outputPath,
        extension: candidate.extension,
        mime: candidate.mime,
        size: stat.size,
        reversible: Boolean(candidate.reversible),
        estimatedQuality: candidate.estimatedQuality,
        accepted: false,
        reason: candidate.reason || null,
        retentionPolicy: candidate.retentionPolicy || "drop_source_after_optimize",
        compatibilityRank: candidate.compatibilityRank || 0,
        sourceKind: "image"
      });
    } catch (_error) {
      // Skip failed candidates and keep exploring the rest.
    }
  };

  if (LOSSLESS_IMAGE_EXTENSIONS.has(extension)) {
    await pushCandidate({
      id: "image-jxl-lossless",
      label: "jxl",
      extension: ".jxl",
      mime: "image/jxl",
      reversible: true,
      estimatedQuality: 100,
      retentionPolicy: tier === "lossless" ? "keep_source" : "drop_source_after_optimize",
      compatibilityRank: 3,
      command: capabilities?.cjxl?.path || "cjxl",
      args: ["--effort=7", "--modular=1"],
      reason: "lossless raster candidate"
    });
  }

  if (canEncodeAnimated) {
    const jxlDistanceByTier = {
      lossless: 0,
      visually_lossless: 1,
      lossy_balanced: 2,
      lossy_aggressive: 3
    };
    const webpQualityByTier = {
      lossless: 100,
      visually_lossless: 82,
      lossy_balanced: 72,
      lossy_aggressive: 60
    };
    const avifQualityByTier = {
      lossless: 100,
      visually_lossless: 55,
      lossy_balanced: 45,
      lossy_aggressive: 35
    };
    const jpegQualityByTier = {
      lossless: 100,
      visually_lossless: 90,
      lossy_balanced: 82,
      lossy_aggressive: 72
    };

    if (capabilities?.cjxl?.available !== false) {
      await pushCandidate({
        id: `image-jxl-${tier}`,
        label: "jxl",
        extension: ".jxl",
        mime: "image/jxl",
        reversible: tier === "lossless" && LOSSLESS_IMAGE_EXTENSIONS.has(extension),
        estimatedQuality: estimateImageQuality("jxl", tier, { distance: jxlDistanceByTier[tier] ?? 1 }),
        retentionPolicy: tier === "lossless" ? "keep_source" : "drop_source_after_optimize",
        compatibilityRank: 3,
        command: capabilities?.cjxl?.path || "cjxl",
        args: [`--effort=${tier === "lossless" ? 7 : 8}`, `--distance=${jxlDistanceByTier[tier] ?? 1}`],
        reason: "JPEG XL candidate"
      });
    }

    await pushCandidate({
      id: `image-webp-${tier}`,
      label: "webp",
      extension: ".webp",
      mime: "image/webp",
      reversible: false,
      estimatedQuality: estimateImageQuality("webp", tier, { quality: webpQualityByTier[tier] ?? 72 }),
      retentionPolicy: "drop_source_after_optimize",
      compatibilityRank: 2,
      options: {
        quality: webpQualityByTier[tier] ?? 72,
        effort: 4
      },
      reason: "WebP candidate"
    });

    await pushCandidate({
      id: `image-avif-${tier}`,
      label: "avif",
      extension: ".avif",
      mime: "image/avif",
      reversible: false,
      estimatedQuality: estimateImageQuality("avif", tier, { quality: avifQualityByTier[tier] ?? 45 }),
      retentionPolicy: "drop_source_after_optimize",
      compatibilityRank: 1,
      options: {
        quality: avifQualityByTier[tier] ?? 45,
        effort: 5
      },
      reason: "AVIF candidate"
    });

    if (extension === ".jpg" || extension === ".jpeg") {
      await pushCandidate({
        id: `image-jpeg-${tier}`,
        label: "jpeg",
        extension: ".jpg",
        mime: "image/jpeg",
        reversible: false,
        estimatedQuality: estimateImageQuality("jpeg", tier, { quality: jpegQualityByTier[tier] ?? 82 }),
        retentionPolicy: "drop_source_after_optimize",
        compatibilityRank: 4,
        options: {
          quality: jpegQualityByTier[tier] ?? 82,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: "4:2:0"
        },
        reason: "JPEG recompression candidate"
      });
    }
  }

  return candidates;
}

async function createVideoCandidates(sourcePath, probe, tier, capabilities, workDir) {
  const videoStream = probe?.streams?.find((stream) => stream.codec_type === "video") || null;
  const sourceLossless = isLosslessVideoCodec(videoStream?.codec_name);
  const candidates = [];
  const extension = ".mkv";

  const pushCandidate = async (candidate) => {
    const outputPath = path.join(workDir, `${uuid()}${candidate.extension}`);
    try {
      const ffmpegStatic = getFfmpegStaticPath();
      if (!ffmpegStatic) {
        return;
      }
      const args = ["-y", "-i", sourcePath, "-map", "0", ...candidate.ffmpegArgs];
      await spawnCapture(ffmpegStatic, args.concat(outputPath), { timeoutMs: 120_000 });
      const stat = await fs.stat(outputPath);
      candidates.push({
        id: candidate.id,
        label: candidate.label,
        path: outputPath,
        extension: candidate.extension,
        mime: candidate.mime,
        size: stat.size,
        reversible: Boolean(candidate.reversible),
        estimatedQuality: candidate.estimatedQuality,
        accepted: false,
        reason: candidate.reason || null,
        retentionPolicy: candidate.retentionPolicy || "drop_source_after_optimize",
        compatibilityRank: candidate.compatibilityRank || 0,
        sourceKind: "video"
      });
    } catch (_error) {
      // Skip failed candidates.
    }
  };

  if (tier === "lossless" && sourceLossless) {
    await pushCandidate({
      id: "video-ffv1",
      label: "ffv1",
      extension,
      mime: "video/x-matroska",
      reversible: true,
      estimatedQuality: 100,
      retentionPolicy: "keep_source",
      compatibilityRank: 1,
      ffmpegArgs: ["-c:v", "ffv1", "-level", "3", "-c:a", "copy", "-c:s", "copy"],
      reason: "lossless archival master"
    });
  }

  if (tier !== "lossless" && capabilities?.av1Encoder?.available) {
    const settingsByTier = {
      visually_lossless: { crf: 28, preset: 5, quality: 97 },
      lossy_balanced: { crf: 32, preset: 6, quality: 93 },
      lossy_aggressive: { crf: 36, preset: 6, quality: 88 }
    };
    const settings = settingsByTier[tier] || settingsByTier.visually_lossless;
    await pushCandidate({
      id: `video-av1-${tier}`,
      label: "av1",
      extension,
      mime: "video/x-matroska",
      reversible: false,
      estimatedQuality: estimateVideoQuality("av1", tier, { crf: settings.crf }),
      retentionPolicy: "drop_source_after_optimize",
      compatibilityRank: 2,
      ffmpegArgs: [
        "-c:v",
        capabilities.av1Encoder.value,
        ...(capabilities.av1Encoder.value === "libsvtav1"
          ? ["-crf", String(settings.crf), "-preset", String(settings.preset)]
          : ["-crf", String(settings.crf), "-cpu-used", "4"]),
        "-c:a",
        "copy",
        "-c:s",
        "copy"
      ],
      reason: "AV1 access copy"
    });
  }

  return { candidates, sourceLossless, videoStream };
}

async function createAudioCandidates(sourcePath, tier, capabilities, workDir) {
  const extension = extname(sourcePath);
  const ffmpegStatic = getFfmpegStaticPath();
  if (!ffmpegStatic) {
    return [];
  }

  const candidates = [];
  const pushCandidate = async (candidate) => {
    const outputPath = path.join(workDir, `${uuid()}${candidate.extension}`);
    try {
      const args = ["-y", "-i", sourcePath, ...candidate.ffmpegArgs, outputPath];
      await spawnCapture(ffmpegStatic, args, { timeoutMs: 120_000 });
      const stat = await fs.stat(outputPath);
      candidates.push({
        id: candidate.id,
        label: candidate.label,
        path: outputPath,
        extension: candidate.extension,
        mime: candidate.mime,
        size: stat.size,
        reversible: Boolean(candidate.reversible),
        estimatedQuality: candidate.estimatedQuality,
        accepted: false,
        reason: candidate.reason || null,
        retentionPolicy: candidate.retentionPolicy || "drop_source_after_optimize",
        compatibilityRank: candidate.compatibilityRank || 0,
        sourceKind: "audio"
      });
    } catch (_error) {
      // Skip failed candidates.
    }
  };

  if (LOSSLESS_AUDIO_EXTENSIONS.has(extension) && tier === "lossless") {
    await pushCandidate({
      id: "audio-flac",
      label: "flac",
      extension: ".flac",
      mime: "audio/flac",
      reversible: true,
      estimatedQuality: 100,
      retentionPolicy: "keep_source",
      compatibilityRank: 1,
      ffmpegArgs: ["-map", "0:a", "-c:a", "flac"],
      reason: "lossless audio candidate"
    });
  }

  if (tier !== "lossless" && (LOSSLESS_AUDIO_EXTENSIONS.has(extension) || LOSSY_AUDIO_EXTENSIONS.has(extension))) {
    const settingsByTier = {
      visually_lossless: { bitrate: 128_000, quality: 92 },
      lossy_balanced: { bitrate: 96_000, quality: 84 },
      lossy_aggressive: { bitrate: 64_000, quality: 76 }
    };
    const settings = settingsByTier[tier] || settingsByTier.visually_lossless;
    await pushCandidate({
      id: `audio-opus-${tier}`,
      label: "opus",
      extension: ".opus",
      mime: "audio/ogg",
      reversible: false,
      estimatedQuality: estimateAudioQuality("opus", tier, { bitrate: settings.bitrate }),
      retentionPolicy: "drop_source_after_optimize",
      compatibilityRank: 2,
      ffmpegArgs: ["-map", "0:a", "-c:a", "libopus", "-b:a", `${Math.round(settings.bitrate / 1000)}k`],
      reason: "Opus access copy"
    });
  }

  return candidates;
}

function selectCandidate(sourceSize, tier, candidates, kind) {
  const threshold = qualityThresholdForTier(tier);
  const winThreshold = sizeWinForTier(tier, kind);
  const accepted = candidates
    .map((candidate) => ({
      ...candidate,
      accepted:
        candidate.reversible
          ? candidate.size < sourceSize
          : tier === "lossless"
            ? false
            : candidate.estimatedQuality >= threshold && candidate.size <= sourceSize * (1 - winThreshold)
    }))
    .filter((candidate) => candidate.accepted);

  if (accepted.length === 0) {
    return {
      selectedCandidate: null,
      acceptedCandidates: []
    };
  }

  accepted.sort((left, right) => {
    if (left.size !== right.size) {
      return left.size - right.size;
    }
    if (right.compatibilityRank !== left.compatibilityRank) {
      return right.compatibilityRank - left.compatibilityRank;
    }
    return right.estimatedQuality - left.estimatedQuality;
  });

  return {
    selectedCandidate: accepted[0],
    acceptedCandidates: accepted
  };
}

async function planMediaOptimization(sourcePath, metadata, preferences, capabilities, workDir) {
  const tier = resolveOptimizationTier(preferences);
  const kind = metadata.kind || "file";
  const sourceSize = (await fs.stat(sourcePath)).size;
  const baseSummary = metadata.summary || path.basename(sourcePath);

  if (kind === "image") {
    const candidates = await createImageCandidates(sourcePath, metadata, tier, capabilities, workDir);
    const { selectedCandidate, acceptedCandidates } = selectCandidate(sourceSize, tier, candidates, kind);
    return {
      kind,
      tier,
      sourceSize,
      sourceSummary: baseSummary,
      selectedCandidate,
      candidateMetrics: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        size: candidate.size,
        estimatedQuality: candidate.estimatedQuality,
        reversible: candidate.reversible,
        accepted: acceptedCandidates.some((acceptedCandidate) => acceptedCandidate.id === candidate.id),
        reason: candidate.reason || undefined
      })),
      derivativeArtifacts: acceptedCandidates,
      artifactRetentionPolicy: selectedCandidate?.retentionPolicy || "keep_source",
      actions: selectedCandidate
        ? [`selected ${selectedCandidate.label} candidate`, ...acceptedCandidates.map((candidate) => `considered ${candidate.label}`)]
        : ["kept source artifact"],
      previewSourcePath: selectedCandidate?.path || sourcePath
    };
  }

  if (kind === "video") {
    const probe = metadata.probe || (await probeVideo(sourcePath));
    const { candidates, sourceLossless, videoStream } = await createVideoCandidates(sourcePath, probe, tier, capabilities, workDir);
    const { selectedCandidate, acceptedCandidates } = selectCandidate(sourceSize, tier, candidates, kind);
    return {
      kind,
      tier,
      sourceSize,
      sourceSummary: `${videoStream?.codec_name || "unknown"} ${videoStream?.width || "?"}x${videoStream?.height || "?"}`,
      selectedCandidate,
      candidateMetrics: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        size: candidate.size,
        estimatedQuality: candidate.estimatedQuality,
        reversible: candidate.reversible,
        accepted: acceptedCandidates.some((acceptedCandidate) => acceptedCandidate.id === candidate.id),
        reason: candidate.reason || undefined
      })),
      derivativeArtifacts: acceptedCandidates,
      artifactRetentionPolicy: selectedCandidate?.retentionPolicy || (sourceLossless ? "keep_source" : "drop_source_after_optimize"),
      actions: selectedCandidate
        ? [`selected ${selectedCandidate.label} candidate`]
        : [sourceLossless ? "kept source lossless video" : "kept source video"],
      previewSourcePath: selectedCandidate?.path || sourcePath
    };
  }

  if (kind === "audio") {
    const candidates = await createAudioCandidates(sourcePath, tier, capabilities, workDir);
    const { selectedCandidate, acceptedCandidates } = selectCandidate(sourceSize, tier, candidates, kind);
    return {
      kind,
      tier,
      sourceSize,
      sourceSummary: `${metadata.codec || "audio"} ${metadata.sampleRate || "?"}Hz`,
      selectedCandidate,
      candidateMetrics: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        size: candidate.size,
        estimatedQuality: candidate.estimatedQuality,
        reversible: candidate.reversible,
        accepted: acceptedCandidates.some((acceptedCandidate) => acceptedCandidate.id === candidate.id),
        reason: candidate.reason || undefined
      })),
      derivativeArtifacts: acceptedCandidates,
      artifactRetentionPolicy: selectedCandidate?.retentionPolicy || "keep_source",
      actions: selectedCandidate ? [`selected ${selectedCandidate.label} candidate`] : ["kept source audio"],
      previewSourcePath: selectedCandidate?.path || sourcePath
    };
  }

  return {
    kind: "file",
    tier,
    sourceSize,
    sourceSummary: baseSummary,
    selectedCandidate: null,
    candidateMetrics: [],
    derivativeArtifacts: [],
    artifactRetentionPolicy: "keep_source",
    actions: ["kept generic file"],
    previewSourcePath: sourcePath
  };
}

module.exports = {
  planMediaOptimization,
  qualityThresholdForTier
};
