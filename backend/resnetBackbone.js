const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const ort = require("onnxruntime-node");

const IMAGE_MEAN = [0.485, 0.456, 0.406];
const IMAGE_STD = [0.229, 0.224, 0.225];
const TARGET_SIZE = 224;
const BUNDLED_MODEL_PATH = path.join(__dirname, "generated", "model_quantized.onnx");

const sessionCache = new Map();

async function createInputTensor(filePath) {
  const { data, info } = await sharp(filePath)
    .resize({
      width: TARGET_SIZE,
      height: TARGET_SIZE,
      fit: "cover",
      position: "centre"
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = new Float32Array(1 * 3 * TARGET_SIZE * TARGET_SIZE);
  for (let y = 0; y < TARGET_SIZE; y += 1) {
    for (let x = 0; x < TARGET_SIZE; x += 1) {
      const pixelOffset = (y * TARGET_SIZE + x) * info.channels;
      for (let channel = 0; channel < 3; channel += 1) {
        tensor[channel * TARGET_SIZE * TARGET_SIZE + y * TARGET_SIZE + x] =
          data[pixelOffset + channel] / 255 / IMAGE_STD[channel] - IMAGE_MEAN[channel] / IMAGE_STD[channel];
      }
    }
  }

  return new ort.Tensor("float32", tensor, [1, 3, TARGET_SIZE, TARGET_SIZE]);
}

async function getSession(modelPath) {
  if (!sessionCache.has(modelPath)) {
    sessionCache.set(modelPath, ort.InferenceSession.create(modelPath));
  }
  return sessionCache.get(modelPath);
}

function resolveBackboneModelPath(capabilities) {
  if (fs.existsSync(BUNDLED_MODEL_PATH)) {
    return BUNDLED_MODEL_PATH;
  }
  const direct = capabilities?.upscaleRouterModel?.available ? capabilities.upscaleRouterModel.path : null;
  if (direct) {
    return direct;
  }
  return null;
}

async function extractResnetLogits(filePath, capabilities) {
  const modelPath = resolveBackboneModelPath(capabilities);
  if (!modelPath) {
    return null;
  }

  const session = await getSession(modelPath);
  const inputName = session.inputNames[0] || "pixel_values";
  const outputName = session.outputNames[0] || "logits";
  const outputs = await session.run({
    [inputName]: await createInputTensor(filePath)
  });

  return Array.from(outputs[outputName]?.data || []);
}

module.exports = {
  extractResnetLogits
};
