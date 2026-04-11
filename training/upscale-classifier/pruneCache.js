const fs = require("node:fs/promises");
const path = require("node:path");

const { loadSplit } = require("./datasetUtils");
const { cacheRoot, ensureSampleFile } = require("./sampleUtils");

const trainPath = path.join(__dirname, "train-samples.json");
const validationPath = path.join(__dirname, "validation-samples.json");
const benchmarkPath = path.join(__dirname, "benchmark-samples.json");

async function collectReferencedPaths() {
  const splits = [
    await loadSplit("train", trainPath),
    await loadSplit("validation", validationPath),
    await loadSplit("benchmark", benchmarkPath)
  ];
  const referenced = new Set();
  for (const split of splits) {
    for (const sample of split.samples) {
      referenced.add(await ensureSampleFile(sample.url, split.name));
    }
  }
  referenced.add(path.join(cacheRoot, "distillation-report.json"));
  referenced.add(path.join(cacheRoot, "resnet18", "model_quantized.onnx"));
  return referenced;
}

async function walk(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const nextPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(nextPath)));
    } else if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files;
}

async function main() {
  const referenced = await collectReferencedPaths();
  const files = await walk(cacheRoot);
  let removed = 0;
  for (const filePath of files) {
    if (referenced.has(filePath)) {
      continue;
    }
    await fs.rm(filePath, { force: true });
    removed += 1;
  }
  process.stdout.write(`Removed ${removed} unused cached files from ${cacheRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
