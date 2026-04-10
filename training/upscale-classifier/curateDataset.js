const fs = require("node:fs/promises");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const configPath = path.join(__dirname, "sources.json");
const cacheDir = path.join(rootDir, "training-cache", "upscale-classifier");
const outputPath = path.join(cacheDir, "manifest.json");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function buildClassIndex(config) {
  return new Map((config.classes || []).map((item) => [item.id, item]));
}

function buildManifest(config) {
  const classIndex = buildClassIndex(config);
  const classes = (config.classes || []).map((entry) => ({
    ...entry,
    sources: (config.sources || [])
      .filter((source) => (source.useForClasses || []).includes(entry.id))
      .map((source) => ({
        id: source.id,
        status: source.status,
        license: source.license,
        url: source.url
      }))
  }));

  const totals = classes.reduce(
    (accumulator, entry) => {
      accumulator.targetImages += entry.targetCount || 0;
      return accumulator;
    },
    { targetImages: 0 }
  );

  const reviewQueue = (config.sources || [])
    .filter((source) => source.status === "review_required" || source.status === "high_risk")
    .map((source) => ({
      id: source.id,
      status: source.status,
      license: source.license,
      url: source.url,
      impactedClasses: (source.useForClasses || []).filter((classId) => classIndex.has(classId))
    }));

  return {
    generatedAt: new Date().toISOString(),
    version: config.version || 1,
    totals,
    classes,
    reviewQueue
  };
}

function renderSummary(manifest) {
  const lines = [];
  lines.push("Upscale Router Dataset Plan");
  lines.push("");
  lines.push(`Target images: ${manifest.totals.targetImages}`);
  lines.push("");

  for (const entry of manifest.classes) {
    lines.push(`- ${entry.id}: ${entry.targetCount} images`);
    lines.push(`  Preferred upscalers: ${entry.preferredUpscalers.join(", ")}`);
    lines.push(`  Source pool: ${entry.sources.map((source) => `${source.id} [${source.status}]`).join(", ")}`);
  }

  if (manifest.reviewQueue.length) {
    lines.push("");
    lines.push("Sources requiring explicit review:");
    for (const entry of manifest.reviewQueue) {
      lines.push(`- ${entry.id}: ${entry.status} (${entry.license})`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const command = process.argv[2] || "plan";
  const config = await readJson(configPath);
  const manifest = buildManifest(config);

  await ensureDir(cacheDir);
  await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2));

  if (command === "manifest") {
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  process.stdout.write(renderSummary(manifest));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
