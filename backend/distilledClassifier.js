const fs = require("node:fs/promises");
const path = require("node:path");

const { extractResnetLogits } = require("./resnetBackbone");
const { normalizeUpscaleRoute, UPSCALE_ROUTES } = require("./upscaleRoutes");
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

function softmax(logits, temperature = 1) {
  const safeTemperature = Number.isFinite(temperature) && temperature > 0 ? temperature : 1;
  const scaled = logits.map((value) => value / safeTemperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
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

function getStageTemperature(model, stageName) {
  return model?.temperatures?.[stageName] || 1;
}

function predictStage(stage, featureVector, temperature = 1) {
  let logits;
  if (stage.type === "mlp") {
    const hidden = (stage.hiddenWeights || []).map((weights, hiddenIndex) =>
      Math.max(0, dot(weights, featureVector) + (stage.hiddenBiases?.[hiddenIndex] || 0))
    );
    logits = (stage.outputWeights || []).map((weights, index) => dot(weights, hidden) + (stage.outputBiases?.[index] || 0));
  } else {
    logits = (stage.weights || []).map((weights, index) => dot(weights, featureVector) + (stage.biases?.[index] || 0));
  }
  const probabilities = softmax(logits, temperature);
  return {
    labels: stage.labels || [],
    logits,
    probabilities
  };
}

function sortRouteScores(scores = {}) {
  return Object.entries(scores)
    .map(([route, score]) => ({ route: normalizeUpscaleRoute(route), score }))
    .filter((entry) => entry.route)
    .sort((left, right) => right.score - left.score);
}

function buildAlternatives(scores, route, limit = 2) {
  return sortRouteScores(scores)
    .filter((entry) => entry.route !== route)
    .slice(0, limit);
}

function classifyWithHierarchicalModel(model, featureVector) {
  const familyStage = model.stages?.family;
  const photoStage = model.stages?.photo;
  const graphicStage = model.stages?.graphic;
  if (!familyStage || !photoStage || !graphicStage) {
    return null;
  }

  const family = predictStage(familyStage, featureVector, getStageTemperature(model, "family"));
  const photo = predictStage(photoStage, featureVector, getStageTemperature(model, "photo"));
  const graphic = predictStage(graphicStage, featureVector, getStageTemperature(model, "graphic"));
  const familyScores = Object.fromEntries(family.labels.map((label, index) => [label, family.probabilities[index] || 0]));
  const photoScores = Object.fromEntries(photo.labels.map((label, index) => [label, photo.probabilities[index] || 0]));
  const graphicScores = Object.fromEntries(graphic.labels.map((label, index) => [label, graphic.probabilities[index] || 0]));

  const scores = {
    photo_gentle: (familyScores.photo_like || 0) * (photoScores.photo_gentle || 0),
    photo_general: (familyScores.photo_like || 0) * (photoScores.photo_general || 0),
    art_clean: (familyScores.graphic_like || 0) * (graphicScores.art_clean || 0),
    art_anime: (familyScores.graphic_like || 0) * (graphicScores.art_anime || 0),
    text_ui: (familyScores.graphic_like || 0) * (graphicScores.text_ui || 0)
  };

  const ranked = sortRouteScores(scores);
  const top = ranked[0];
  if (!top) {
    return null;
  }

  return {
    route: top.route,
    confidence: top.score || 0,
    scores,
    alternatives: buildAlternatives(scores, top.route),
    provider: "stout"
  };
}

function classifyFeatureVectorWithModel(model, featureVector) {
  if (model.modelType === "hierarchical") {
    const hierarchical = classifyWithHierarchicalModel(model, featureVector);
    if (hierarchical) {
      return hierarchical;
    }
  }

  const labels = (model.labels || UPSCALE_ROUTES).map((label) => normalizeUpscaleRoute(label));
  const classLogits = (model.weights || []).map((weights, index) => dot(weights, featureVector) + (model.biases?.[index] || 0));
  const probabilities = softmax(classLogits, getStageTemperature(model, "output"));
  const scores = Object.fromEntries(labels.map((label, index) => [label, probabilities[index] || 0]).filter(([label]) => label));
  const ranked = sortRouteScores(scores);
  const top = ranked[0];
  if (!top) {
    return null;
  }

  return {
    route: top.route,
    confidence: top.score || 0,
    scores,
    alternatives: buildAlternatives(scores, top.route),
    provider: "stout"
  };
}

async function buildNormalizedFeatureVector(filePath, model, capabilities) {
  const logits = await extractResnetLogits(filePath, capabilities);
  if (!logits?.length) {
    return null;
  }

  let featureVector = logits;
  const expectedVisualCount = model.featureLayout?.visualCount || 0;
  if (expectedVisualCount) {
    try {
      const visualFeatures = buildFeatureVector(await extractVisualFeatures(filePath)).map((value) => value * VISUAL_FEATURE_SCALE);
      const adjusted =
        visualFeatures.length === expectedVisualCount
          ? visualFeatures
          : [...visualFeatures.slice(0, expectedVisualCount), ...new Array(Math.max(0, expectedVisualCount - visualFeatures.length)).fill(0)];
      featureVector = [...logits, ...adjusted];
    } catch (_error) {
      featureVector = [...logits, ...new Array(expectedVisualCount).fill(0)];
    }
  }

  return normalizeFeatures(featureVector, model.featureMeans || [], model.featureScales || []);
}

function getClassificationMargin(classification) {
  const ranked = sortRouteScores(classification?.scores || {});
  const top = ranked[0]?.score ?? classification?.confidence ?? 0;
  const runnerUp = ranked[1]?.score ?? 0;
  return top - runnerUp;
}

function getGatingThreshold(model, route) {
  const defaultThreshold = { confidence: 0.82, margin: 0.18 };
  const routeThreshold = model?.gating?.routeThresholds?.[route];
  return {
    confidence: routeThreshold?.confidence ?? model?.gating?.defaultThresholds?.confidence ?? defaultThreshold.confidence,
    margin: routeThreshold?.margin ?? model?.gating?.defaultThresholds?.margin ?? defaultThreshold.margin
  };
}

function classificationPassesGate(model, classification) {
  if (!classification?.route) {
    return false;
  }
  const threshold = getGatingThreshold(model, classification.route);
  return classification.confidence >= threshold.confidence && getClassificationMargin(classification) >= threshold.margin;
}

async function classifyImageWithDistilledModel(filePath, capabilities) {
  const model = await loadModel();
  if (!model) {
    return null;
  }

  const normalized = await buildNormalizedFeatureVector(filePath, model, capabilities);
  if (!normalized) {
    return null;
  }

  const classification = classifyFeatureVectorWithModel(model, normalized);
  if (!classification) {
    return null;
  }

  return {
    ...classification,
    accepted: classificationPassesGate(model, classification)
  };
}

module.exports = {
  buildNormalizedFeatureVector,
  classifyFeatureVectorWithModel,
  classifyImageWithDistilledModel,
  classificationPassesGate,
  getClassificationMargin,
  getGatingThreshold,
  loadModel,
  softmax
};
