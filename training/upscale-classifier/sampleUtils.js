const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");

const rootDir = path.resolve(__dirname, "..", "..");
const cacheRoot = path.join(rootDir, "training-cache", "upscale-classifier");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function extFromUrl(url) {
  const pathname = new URL(url).pathname;
  return path.extname(pathname) || ".img";
}

function safeIdFromUrl(url) {
  const pathname = new URL(url).pathname.split("/").pop() || "sample";
  return pathname.replace(/[^a-z0-9._-]+/gi, "_");
}

async function downloadFile(url, outputPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Stow-Upscale-Classifier/1.0"
      }
    });
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      await fs.writeFile(outputPath, Buffer.from(arrayBuffer));
      return;
    }

    lastError = new Error(`Failed to fetch ${url} (${response.status})`);
    if (response.status !== 429 && response.status < 500) {
      break;
    }

    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const baseDelayMs = response.status === 429 ? 5000 : 1500;
    const delayMs = Math.max(retryAfter * 1000, baseDelayMs * (attempt + 1));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

async function ensureSampleFile(url, bucket) {
  const bucketDir = path.join(cacheRoot, bucket);
  await ensureDir(bucketDir);
  const outputPath = path.join(bucketDir, `${safeIdFromUrl(url)}${extFromUrl(url)}`);
  try {
    await fs.access(outputPath);
  } catch (_error) {
    await downloadFile(url, outputPath);
  }
  return outputPath;
}

async function ensureAugmentedImageSet(sourcePath, key, options = {}) {
  const bucketDir = path.join(cacheRoot, "augmented", key);
  await ensureDir(bucketDir);

  const profile = options.profile || "standard";

  const profileVariants = {
    light: [
      {
        name: "orig",
        transform: (image) => image
      },
      {
        name: "tone",
        transform: (image) => image.modulate({ brightness: 1.04, saturation: 1.05 }).sharpen()
      },
      {
        name: "dim",
        transform: (image) => image.modulate({ brightness: 0.92, saturation: 0.95 })
      },
      {
        name: "compressed",
        transform: (image) => image.jpeg({ quality: 82, mozjpeg: true })
      }
    ],
    ui: [
      {
        name: "orig",
        transform: (image) => image
      },
      {
        name: "tone",
        transform: (image) => image.modulate({ brightness: 1.02, saturation: 1.01 }).sharpen()
      }
    ],
    standard: [
      {
        name: "orig",
        transform: (image) => image
      },
      {
        name: "tone",
        transform: (image) => image.modulate({ brightness: 1.05, saturation: 1.08 }).sharpen()
      },
      {
        name: "dim",
        transform: (image) => image.modulate({ brightness: 0.9, saturation: 0.94 })
      },
      {
        name: "compressed",
        transform: (image) => image.jpeg({ quality: 80, mozjpeg: true })
      }
    ]
  };

  const variants = profileVariants[profile] || profileVariants.standard;

  const outputPaths = [];
  for (const variant of variants) {
    const outputPath = path.join(bucketDir, `${variant.name}.jpg`);
    try {
      await fs.access(outputPath);
    } catch (_error) {
      let pipeline = sharp(sourcePath).rotate();
      const transformed = await variant.transform(pipeline);
      await transformed.jpeg({ quality: 90, mozjpeg: true }).toFile(outputPath);
    }
    outputPaths.push(outputPath);
  }

  return outputPaths;
}

module.exports = {
  cacheRoot,
  ensureAugmentedImageSet,
  ensureDir,
  ensureSampleFile,
  readJson,
  readJsonLines
};
