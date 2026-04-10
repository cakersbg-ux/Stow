const fs = require("node:fs/promises");
const path = require("node:path");

const { extractResnetLogits } = require("./resnetBackbone");
const { extractVisualFeatures, buildFeatureVector } = require("./visualFeatures");

const MODEL_PATH = path.join(__dirname, "generated", "upscaleClassifierWeights.json");
const VISUAL_FEATURE_SCALE = 0.35;

let cachedModelPromise = null;

async function loadModel() {
  if (!cachedModelPromise) {
    cachedModelPromise = fs
      .readFile(MODEL_PATH, "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
  }
  return cachedModelPromise;
}

function dot(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] || 0) * (right[index] || 0);
  }
  return total;
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function normalizeFeatures(vector, means, scales) {
  return vector.map((value, index) => {
    const mean = means[index] || 0;
    const scale = scales[index] || 1;
    return (value - mean) / (scale || 1);
  });
}

function predictStage(stage, featureVector) {
  let logits;
  if (stage.type === "mlp") {
    const hidden = (stage.hiddenWeights || []).map((weights, hiddenIndex) =>
      Math.max(0, dot(weights, featureVector) + (stage.hiddenBiases?.[hiddenIndex] || 0))
    );
    logits = (stage.outputWeights || []).map((weights, index) => dot(weights, hidden) + (stage.outputBiases?.[index] || 0));
  } else {
    logits = (stage.weights || []).map((weights, index) => dot(weights, featureVector) + (stage.biases?.[index] || 0));
  }
  const probabilities = softmax(logits);
  return {
    labels: stage.labels || [],
    probabilities
  };
}

function classifyWithHierarchicalModel(model, featureVector) {
  const familyStage = model.stages?.family;
  const photoStage = model.stages?.photo;
  const syntheticStage = model.stages?.synthetic;
  if (!familyStage || !photoStage || !syntheticStage) {
    return null;
  }

  const family = predictStage(familyStage, featureVector);
  const photo = predictStage(photoStage, featureVector);
  const synthetic = predictStage(syntheticStage, featureVector);
  const familyScores = Object.fromEntries(family.labels.map((label, index) => [label, family.probabilities[index] || 0]));
  const photoScores = Object.fromEntries(photo.labels.map((label, index) => [label, photo.probabilities[index] || 0]));
  const syntheticScores = Object.fromEntries(synthetic.labels.map((label, index) => [label, synthetic.probabilities[index] || 0]));
  const scores = {
    portrait: (familyScores.photo_family || 0) * (photoScores.portrait || 0),
    landscape: (familyScores.photo_family || 0) * (photoScores.landscape || 0),
    photo: (familyScores.photo_family || 0) * (photoScores.photo || 0),
    illustration: (familyScores.synthetic_family || 0) * (syntheticScores.illustration || 0),
    anime: (familyScores.synthetic_family || 0) * (syntheticScores.anime || 0),
    ui_screenshot: (familyScores.synthetic_family || 0) * (syntheticScores.ui_screenshot || 0)
  };
  const labels = Object.keys(scores);
  const topIndex = labels.reduce((best, label, index) => (scores[label] > scores[labels[best]] ? index : best), 0);
  return {
    category: labels[topIndex] || "photo",
    confidence: scores[labels[topIndex]] || 0,
    scores
  };
}

async function classifyImageWithDistilledModel(filePath, capabilities) {
  const model = await loadModel();
  if (!model) {
    return null;
  }

  const logits = await extractResnetLogits(filePath, capabilities);
  if (!logits?.length) {
    return null;
  }

  let featureVector = logits;
  if (model.featureLayout?.visualCount) {
    try {
      const visualFeatures = buildFeatureVector(await extractVisualFeatures(filePath)).map((value) => value * VISUAL_FEATURE_SCALE);
      featureVector = [...logits, ...visualFeatures];
    } catch (_error) {
      featureVector = [...logits, ...new Array(model.featureLayout.visualCount).fill(0)];
    }
  }

  const normalized = normalizeFeatures(featureVector, model.featureMeans || [], model.featureScales || []);
  if (model.modelType === "hierarchical") {
    const hierarchical = classifyWithHierarchicalModel(model, normalized);
    if (hierarchical) {
      return {
        ...hierarchical,
        provider: "distilled"
      };
    }
  }

  const classLogits = (model.weights || []).map((weights, index) => dot(weights, normalized) + (model.biases?.[index] || 0));
  const probabilities = softmax(classLogits);
  const labels = model.labels || [];
  const topIndex = probabilities.reduce((best, value, index) => (value > probabilities[best] ? index : best), 0);
  const scores = Object.fromEntries(labels.map((label, index) => [label, probabilities[index] || 0]));

  return {
    category: labels[topIndex] || "photo",
    confidence: probabilities[topIndex] || 0,
    scores,
    provider: "distilled"
  };
}

module.exports = {
  classifyImageWithDistilledModel
};
