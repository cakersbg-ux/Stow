const fs = require("node:fs/promises");
const path = require("node:path");

const { classifyImageWithClip } = require("../../backend/clipClassifier");
const { classifyImageWithDistilledModel } = require("../../backend/distilledClassifier");
const { attemptAutomaticClassification } = require("../../backend/mediaTools");
const { ensureDir, ensureSampleFile, readJson } = require("./sampleUtils");

const samplesPath = path.join(__dirname, "benchmark-samples.json");
const bundledBackbonePath = path.join(__dirname, "..", "..", "backend", "generated", "model_quantized.onnx");
const backboneCachePath = path.join(__dirname, "..", "..", "training-cache", "upscale-classifier", "resnet18", "model_quantized.onnx");
const BACKBONE_URL = "https://huggingface.co/Xenova/resnet-18/resolve/main/onnx/model_quantized.onnx";

async function ensureBackboneModel() {
  await ensureDir(path.dirname(backboneCachePath));
  try {
    await fs.access(backboneCachePath);
  } catch (_error) {
    const response = await fetch(BACKBONE_URL, {
      headers: {
        "User-Agent": "Stow-Upscale-Classifier/1.0"
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${BACKBONE_URL} (${response.status})`);
    }
    await fs.writeFile(backboneCachePath, Buffer.from(await response.arrayBuffer()));
  }

  await ensureDir(path.dirname(bundledBackbonePath));
  try {
    await fs.access(bundledBackbonePath);
  } catch (_error) {
    await fs.copyFile(backboneCachePath, bundledBackbonePath);
  }

  return {
    upscaleRouterModel: {
      available: true,
      path: bundledBackbonePath
    }
  };
}

async function classifyWithProvider(filePath, provider, capabilities) {
  if (provider === "distilled") {
    return classifyImageWithDistilledModel(filePath, capabilities);
  }
  if (provider === "clip") {
    return classifyImageWithClip(filePath);
  }
  if (provider === "hybrid") {
    const result = await attemptAutomaticClassification(filePath, capabilities);
    return result.ok ? result.classification : null;
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function render(provider, results) {
  const correct = results.filter((entry) => entry.expected === entry.predicted).length;
  const lines = [];
  lines.push(`${provider.toUpperCase()} Upscale Router Benchmark`);
  lines.push("");
  lines.push(`Samples: ${results.length}`);
  lines.push(`Correct: ${correct}`);
  lines.push(`Accuracy: ${((correct / Math.max(results.length, 1)) * 100).toFixed(1)}%`);
  lines.push("");
  for (const entry of results) {
    lines.push(
      `- ${entry.id}: expected=${entry.expected} predicted=${entry.predicted} confidence=${Math.round(entry.confidence * 100)}%`
    );
  }
  return `${lines.join("\n")}\n`;
}

async function benchmarkProvider(provider, samples) {
  const results = [];
  const capabilities = provider === "distilled" || provider === "hybrid" ? await ensureBackboneModel() : {};
  for (const sample of samples) {
    const filePath = await ensureSampleFile(sample.url, "benchmarks");
    const prediction = await classifyWithProvider(filePath, provider, capabilities);
    results.push({
      id: sample.id,
      expected: sample.label,
      predicted: prediction?.category || "unavailable",
      confidence: prediction?.confidence || 0
    });
  }
  return results;
}

async function main() {
  const provider = process.argv[2] || "distilled";
  const samples = await readJson(samplesPath);
  const results = await benchmarkProvider(provider, samples);
  process.stdout.write(render(provider, results));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
