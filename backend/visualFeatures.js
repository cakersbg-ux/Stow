const sharp = require("sharp");

const IMAGE_CLASSIFIER_SAMPLE = 96;

function isSkinPixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (!(r > 45 && g > 30 && b > 20 && max - min > 12 && r > g && r > b)) {
    return false;
  }

  const sum = r + g + b || 1;
  const rn = r / sum;
  const gn = g / sum;
  const bn = b / sum;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

  return rn > 0.34 && rn < 0.52 && gn > 0.22 && gn < 0.38 && bn > 0.12 && bn < 0.32 && cb >= 85 && cb <= 135 && cr >= 135 && cr <= 180;
}

function safeRatio(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor === 0) {
    return 0;
  }
  return value / divisor;
}

async function extractVisualFeatures(filePath) {
  const sample = await sharp(filePath, { animated: false })
    .rotate()
    .resize({
      width: IMAGE_CLASSIFIER_SAMPLE,
      height: IMAGE_CLASSIFIER_SAMPLE,
      fit: "inside",
      withoutEnlargement: true
    })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data, info } = sample;
  const width = info.width || 1;
  const height = info.height || 1;
  const channels = Math.max(info.channels || 3, 3);
  const pixelCount = Math.max(width * height, 1);
  const uniqueBuckets = new Set();
  const previousRowLuma = new Array(width).fill(0);
  const hueBuckets = new Array(12).fill(0);
  const lumaBuckets = new Array(8).fill(0);

  let saturationSum = 0;
  let saturationSquaredSum = 0;
  let valueSum = 0;
  let valueSquaredSum = 0;
  let lumaSum = 0;
  let lumaSquaredSum = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  let redSquaredSum = 0;
  let greenSquaredSum = 0;
  let blueSquaredSum = 0;
  let skinPixels = 0;
  let naturePixels = 0;
  let warmPixels = 0;
  let vividPixels = 0;
  let flatPixels = 0;
  let darkPixels = 0;
  let brightPixels = 0;
  let edgeMagnitude = 0;

  for (let y = 0; y < height; y += 1) {
    let leftLuma = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const saturation = max === 0 ? 0 : delta / max;
      const value = max / 255;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const quantized = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

      uniqueBuckets.add(quantized);
      saturationSum += saturation;
      saturationSquaredSum += saturation * saturation;
      valueSum += value;
      valueSquaredSum += value * value;
      lumaSum += luma;
      lumaSquaredSum += luma * luma;
      redSum += r / 255;
      greenSum += g / 255;
      blueSum += b / 255;
      redSquaredSum += (r / 255) * (r / 255);
      greenSquaredSum += (g / 255) * (g / 255);
      blueSquaredSum += (b / 255) * (b / 255);

      if (isSkinPixel(r, g, b)) {
        skinPixels += 1;
      }
      if ((g > r * 0.9 || b > r * 0.9) && (g > 72 || b > 72)) {
        naturePixels += 1;
      }
      if (r > 120 && r > g * 1.08 && r > b * 1.12) {
        warmPixels += 1;
      }
      if (saturation > 0.35 && value > 0.25) {
        vividPixels += 1;
      }
      if (luma < 0.18) {
        darkPixels += 1;
      }
      if (luma > 0.82) {
        brightPixels += 1;
      }

      const horizontal = x > 0 ? Math.abs(luma - leftLuma) : 0;
      const vertical = y > 0 ? Math.abs(luma - previousRowLuma[x]) : 0;
      const gradient = horizontal + vertical;
      edgeMagnitude += gradient;
      if (gradient < 0.05) {
        flatPixels += 1;
      }

      if (delta > 0) {
        let hue;
        if (max === r) {
          hue = ((g - b) / delta) % 6;
        } else if (max === g) {
          hue = (b - r) / delta + 2;
        } else {
          hue = (r - g) / delta + 4;
        }
        const hueIndex = ((Math.round((hue * 60) / 30) % 12) + 12) % 12;
        hueBuckets[hueIndex] += 1;
      }

      const lumaIndex = Math.min(7, Math.max(0, Math.floor(luma * 8)));
      lumaBuckets[lumaIndex] += 1;

      leftLuma = luma;
      previousRowLuma[x] = luma;
    }
  }

  const meanSaturation = saturationSum / pixelCount;
  const meanValue = valueSum / pixelCount;
  const meanLuma = lumaSum / pixelCount;
  const meanRed = redSum / pixelCount;
  const meanGreen = greenSum / pixelCount;
  const meanBlue = blueSum / pixelCount;

  return {
    width,
    height,
    pixelCount,
    aspectRatio: width / Math.max(height, 1),
    paletteDensity: uniqueBuckets.size / pixelCount,
    saturationMean: meanSaturation,
    saturationStd: Math.sqrt(Math.max(0, saturationSquaredSum / pixelCount - meanSaturation * meanSaturation)),
    valueMean: meanValue,
    valueStd: Math.sqrt(Math.max(0, valueSquaredSum / pixelCount - meanValue * meanValue)),
    lumaMean: meanLuma,
    lumaStd: Math.sqrt(Math.max(0, lumaSquaredSum / pixelCount - meanLuma * meanLuma)),
    redMean: meanRed,
    greenMean: meanGreen,
    blueMean: meanBlue,
    redStd: Math.sqrt(Math.max(0, redSquaredSum / pixelCount - meanRed * meanRed)),
    greenStd: Math.sqrt(Math.max(0, greenSquaredSum / pixelCount - meanGreen * meanGreen)),
    blueStd: Math.sqrt(Math.max(0, blueSquaredSum / pixelCount - meanBlue * meanBlue)),
    skinRatio: skinPixels / pixelCount,
    natureRatio: naturePixels / pixelCount,
    warmRatio: warmPixels / pixelCount,
    vividRatio: vividPixels / pixelCount,
    flatRatio: flatPixels / pixelCount,
    darkRatio: darkPixels / pixelCount,
    brightRatio: brightPixels / pixelCount,
    edgeMean: edgeMagnitude / pixelCount,
    hueBuckets: hueBuckets.map((value) => safeRatio(value, pixelCount)),
    lumaBuckets: lumaBuckets.map((value) => safeRatio(value, pixelCount))
  };
}

function buildFeatureVector(features) {
  return [
    features.aspectRatio,
    features.paletteDensity,
    features.saturationMean,
    features.saturationStd,
    features.valueMean,
    features.valueStd,
    features.lumaMean,
    features.lumaStd,
    features.redMean,
    features.greenMean,
    features.blueMean,
    features.redStd,
    features.greenStd,
    features.blueStd,
    features.skinRatio,
    features.natureRatio,
    features.warmRatio,
    features.vividRatio,
    features.flatRatio,
    features.darkRatio,
    features.brightRatio,
    features.edgeMean,
    ...features.hueBuckets,
    ...features.lumaBuckets
  ];
}

module.exports = {
  buildFeatureVector,
  extractVisualFeatures
};
