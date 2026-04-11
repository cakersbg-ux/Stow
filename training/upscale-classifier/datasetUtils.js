const crypto = require("node:crypto");
const path = require("node:path");

const { normalizeUpscaleRoute, UPSCALE_ROUTES } = require("../../backend/upscaleRoutes");
const { ensureSampleFile, hashFile, normalizeSampleUrl, readJson } = require("./sampleUtils");

function inferSourceId(url) {
  if (typeof url !== "string") {
    return "unknown";
  }
  if (url.includes("upload.wikimedia.org")) {
    return "wikimedia_commons";
  }
  if (url.includes("huggingface.co/datasets/Xenova/transformers.js-docs")) {
    return "xenova_transformers_docs";
  }
  if (path.isAbsolute(url) || url.startsWith("file://")) {
    return "local_file";
  }
  return "unknown";
}

function inferLicense(url) {
  if (typeof url !== "string") {
    return "unknown";
  }
  if (url.includes("upload.wikimedia.org")) {
    return "Wikimedia Commons source file license";
  }
  if (url.includes("huggingface.co/datasets/Xenova/transformers.js-docs")) {
    return "Transformers.js docs sample asset";
  }
  if (path.isAbsolute(url) || url.startsWith("file://")) {
    return "local";
  }
  return "unknown";
}

function inferAttribution(url) {
  if (typeof url !== "string") {
    return "Unknown";
  }
  if (url.includes("upload.wikimedia.org")) {
    return "Wikimedia Commons contributors";
  }
  if (url.includes("huggingface.co/datasets/Xenova/transformers.js-docs")) {
    return "Xenova transformers.js docs samples";
  }
  if (path.isAbsolute(url) || url.startsWith("file://")) {
    return "Local file";
  }
  return "Unknown";
}

function normalizeSampleEntry(entry) {
  const route = normalizeUpscaleRoute(entry.route ?? entry.label);
  if (!route) {
    throw new Error(`Unsupported route label in sample manifest: ${entry.route ?? entry.label ?? "missing"}`);
  }
  if (typeof entry.url !== "string" || !entry.url) {
    throw new Error("Sample manifest entry is missing a url");
  }

  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : undefined,
    route,
    url: entry.url,
    sourceId: entry.sourceId || inferSourceId(entry.url),
    license: entry.license || inferLicense(entry.url),
    attribution: entry.attribution || inferAttribution(entry.url),
    notes: entry.notes || null
  };
}

async function loadSplit(splitName, filePath) {
  const rows = await readJson(filePath);
  const samples = rows.map(normalizeSampleEntry);
  return {
    name: splitName,
    path: filePath,
    samples
  };
}

function collectRouteCounts(samples) {
  return Object.fromEntries(UPSCALE_ROUTES.map((route) => [route, samples.filter((sample) => sample.route === route).length]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pairKey(left, right) {
  return [left, right].sort().join("::");
}

async function validateDatasetSplits(splits, options = {}) {
  const resolveSampleFile = options.resolveSampleFile || ensureSampleFile;
  const exactOverlaps = [];
  const normalizedOverlaps = [];
  const hashOverlaps = [];
  const seenExact = new Map();
  const seenNormalized = new Map();
  const seenHashes = new Map();
  const hashCache = new Map();

  for (const split of splits) {
    for (const sample of split.samples) {
      const exact = sample.url;
      if (seenExact.has(exact) && seenExact.get(exact) !== split.name) {
        exactOverlaps.push({ splitA: seenExact.get(exact), splitB: split.name, url: sample.url });
      } else if (!seenExact.has(exact)) {
        seenExact.set(exact, split.name);
      }

      const normalized = normalizeSampleUrl(sample.url);
      if (seenNormalized.has(normalized) && seenNormalized.get(normalized) !== split.name) {
        normalizedOverlaps.push({ splitA: seenNormalized.get(normalized), splitB: split.name, url: sample.url, normalized });
      } else if (!seenNormalized.has(normalized)) {
        seenNormalized.set(normalized, split.name);
      }

      const localPath = await resolveSampleFile(sample.url, `${split.name}-validation`);
      const contentHash = hashCache.get(localPath) || (await hashFile(localPath));
      hashCache.set(localPath, contentHash);
      const existingHash = seenHashes.get(contentHash);
      if (existingHash && existingHash.split !== split.name) {
        hashOverlaps.push({
          splitA: existingHash.split,
          splitB: split.name,
          urlA: existingHash.url,
          urlB: sample.url,
          hash: contentHash
        });
      } else if (!existingHash) {
        seenHashes.set(contentHash, { split: split.name, url: sample.url });
      }
    }
  }

  const overlapSummary = {
    exact: exactOverlaps,
    normalized: normalizedOverlaps,
    hash: hashOverlaps
  };

  if (exactOverlaps.length || normalizedOverlaps.length || hashOverlaps.length) {
    throw new Error(`Dataset split overlap detected: ${JSON.stringify(overlapSummary)}`);
  }

  return {
    overlaps: overlapSummary,
    fingerprints: Object.fromEntries(splits.map((split) => [split.name, fingerprint(split.samples)])),
    routeCoverage: Object.fromEntries(splits.map((split) => [split.name, collectRouteCounts(split.samples)]))
  };
}

function buildMetrics(results) {
  const total = results.length;
  const correct = results.filter((entry) => entry.expected === entry.predicted).length;
  const top2Correct = results.filter((entry) => entry.expected === entry.predicted || entry.top2.includes(entry.expected)).length;
  const rejected = results.filter((entry) => entry.accepted === false).length;
  const accepted = results.filter((entry) => entry.accepted !== false).length;
  const perRoute = Object.fromEntries(
    UPSCALE_ROUTES.map((route) => {
      const tp = results.filter((entry) => entry.expected === route && entry.predicted === route).length;
      const fp = results.filter((entry) => entry.expected !== route && entry.predicted === route).length;
      const fn = results.filter((entry) => entry.expected === route && entry.predicted !== route).length;
      const precision = tp / Math.max(tp + fp, 1);
      const recall = tp / Math.max(tp + fn, 1);
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      return [route, { precision, recall, f1, support: results.filter((entry) => entry.expected === route).length }];
    })
  );

  const confusionMatrix = Object.fromEntries(
    UPSCALE_ROUTES.map((expected) => [
      expected,
      Object.fromEntries(
        UPSCALE_ROUTES.map((predicted) => [
          predicted,
          results.filter((entry) => entry.expected === expected && entry.predicted === predicted).length
        ])
      )
    ])
  );

  return {
    total,
    correct,
    accuracy: correct / Math.max(total, 1),
    top2Accuracy: top2Correct / Math.max(total, 1),
    accepted,
    rejected,
    acceptRate: accepted / Math.max(total, 1),
    rejectRate: rejected / Math.max(total, 1),
    perRoute,
    confusionMatrix,
    lowConfidence: results.filter((entry) => entry.accepted === false || entry.confidence < 0.8 || entry.margin < 0.12)
  };
}

function renderMetricsReport(title, splitName, samples, validation, metrics, results) {
  const lines = [];
  lines.push(title);
  lines.push("");
  lines.push(`Split: ${splitName}`);
  lines.push(`Samples: ${samples.length}`);
  lines.push(`Coverage: ${JSON.stringify(collectRouteCounts(samples))}`);
  if (validation) {
    lines.push(`Fingerprints: ${JSON.stringify(validation.fingerprints)}`);
  }
  lines.push(`Accuracy: ${(metrics.accuracy * 100).toFixed(1)}% (${metrics.correct}/${metrics.total})`);
  lines.push(`Top-2 accuracy: ${(metrics.top2Accuracy * 100).toFixed(1)}%`);
  lines.push(`Acceptance: ${(metrics.acceptRate * 100).toFixed(1)}% accepted, ${(metrics.rejectRate * 100).toFixed(1)}% rejected`);
  lines.push(`Per-route metrics: ${JSON.stringify(metrics.perRoute)}`);
  lines.push(`Confusion matrix: ${JSON.stringify(metrics.confusionMatrix)}`);
  lines.push("");
  for (const result of results) {
    const status = result.accepted === false ? " status=rejected" : result.accepted === true ? " status=accepted" : "";
    lines.push(
      `- ${result.id}: expected=${result.expected} predicted=${result.predicted} confidence=${Math.round(result.confidence * 100)}% margin=${Math.round(result.margin * 100)}% top2=${result.top2.join(",")}${status}`
    );
  }
  if (metrics.lowConfidence.length) {
    lines.push("");
    lines.push(`Low-signal predictions: ${metrics.lowConfidence.map((entry) => entry.id).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

module.exports = {
  UPSCALE_ROUTES,
  buildMetrics,
  collectRouteCounts,
  inferAttribution,
  inferLicense,
  inferSourceId,
  loadSplit,
  normalizeSampleEntry,
  renderMetricsReport,
  validateDatasetSplits
};
