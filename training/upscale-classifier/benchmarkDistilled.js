const path = require("node:path");

const { classifyImageWithDistilledModel } = require("../../backend/distilledClassifier");
const { buildMetrics, loadSplit, renderMetricsReport, validateDatasetSplits } = require("./datasetUtils");
const { ensureSampleFile } = require("./sampleUtils");

const trainPath = path.join(__dirname, "train-samples.json");
const validationPath = path.join(__dirname, "validation-samples.json");
const benchmarkPath = path.join(__dirname, "benchmark-samples.json");

async function main() {
  const trainSplit = await loadSplit("train", trainPath);
  const validationSplit = await loadSplit("validation", validationPath);
  const benchmarkSplit = await loadSplit("benchmark", benchmarkPath);
  const splitValidation = await validateDatasetSplits([trainSplit, validationSplit, benchmarkSplit]);
  const results = [];

  for (const sample of benchmarkSplit.samples) {
    const filePath = await ensureSampleFile(sample.url, "benchmark");
    const prediction = await classifyImageWithDistilledModel(filePath, {});
    results.push({
      id: sample.id || path.basename(filePath),
      expected: sample.route,
      predicted: prediction?.route || "unavailable",
      confidence: prediction?.confidence || 0,
      margin:
        (prediction?.confidence || 0) -
        (prediction?.alternatives?.[0]?.score || 0),
      top2: [prediction?.route, ...(prediction?.alternatives || []).map((entry) => entry.route)].filter(Boolean),
      accepted: prediction?.accepted ?? false
    });
  }

  const metrics = buildMetrics(results);
  process.stdout.write(renderMetricsReport("Stout Upscale Router Benchmark", "benchmark", benchmarkSplit.samples, splitValidation, metrics, results));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
