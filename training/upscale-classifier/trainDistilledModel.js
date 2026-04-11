const fs = require("node:fs/promises");
const path = require("node:path");

const { extractResnetLogits } = require("../../backend/resnetBackbone");
const { normalizeUpscaleRoute, UPSCALE_ROUTES } = require("../../backend/upscaleRoutes");
const { extractVisualFeatures, buildFeatureVector } = require("../../backend/visualFeatures");
const { buildMetrics, loadSplit, renderMetricsReport, validateDatasetSplits } = require("./datasetUtils");
const { ensureAugmentedImageSet, ensureDir, ensureSampleFile, readJsonLines } = require("./sampleUtils");

const rootDir = path.resolve(__dirname, "..", "..");
const trainPath = path.join(__dirname, "train-samples.json");
const validationPath = path.join(__dirname, "validation-samples.json");
const benchmarkPath = path.join(__dirname, "benchmark-samples.json");
const outputDir = path.join(rootDir, "backend", "generated");
const outputPath = path.join(outputDir, "upscaleClassifierWeights.json");
const bundledBackbonePath = path.join(outputDir, "model_quantized.onnx");
const cacheReportPath = path.join(rootDir, "training-cache", "upscale-classifier", "distillation-report.json");
const backboneCachePath = path.join(rootDir, "training-cache", "upscale-classifier", "resnet18", "model_quantized.onnx");

const ROUTE_FAMILY_LABELS = ["photo_like", "graphic_like"];
const PHOTO_ROUTE_LABELS = ["photo_gentle", "photo_general"];
const GRAPHIC_ROUTE_LABELS = ["art_clean", "art_anime", "text_ui"];
const EPOCHS = 300;
const LEARNING_RATE = 0.03;
const L2 = 0.0003;
const BACKBONE_URL = "https://huggingface.co/Xenova/resnet-18/resolve/main/onnx/model_quantized.onnx";
const AUGMENTATION_VERSION = "v3";
const VISUAL_FEATURE_SCALE = 0.35;
const HIDDEN_SIZES = {
  family: 24,
  photo: 40,
  graphic: 32
};
const DEFAULT_GATING = {
  confidence: 0.84,
  margin: 0.18
};

function zeros(length) {
  return new Array(length).fill(0);
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

function relu(value) {
  return value > 0 ? value : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeMatrix(matrix) {
  const featureCount = matrix[0]?.length || 0;
  const means = zeros(featureCount);
  const scales = zeros(featureCount);

  for (const row of matrix) {
    for (let index = 0; index < featureCount; index += 1) {
      means[index] += row[index];
    }
  }
  for (let index = 0; index < featureCount; index += 1) {
    means[index] /= Math.max(matrix.length, 1);
  }
  for (const row of matrix) {
    for (let index = 0; index < featureCount; index += 1) {
      const diff = row[index] - means[index];
      scales[index] += diff * diff;
    }
  }
  for (let index = 0; index < featureCount; index += 1) {
    scales[index] = Math.sqrt(scales[index] / Math.max(matrix.length, 1)) || 1;
  }

  return {
    means,
    scales,
    matrix: matrix.map((row) => row.map((value, index) => (value - means[index]) / scales[index]))
  };
}

function buildClassWeights(labels, orderedLabels) {
  const counts = Object.fromEntries(orderedLabels.map((label) => [label, 0]));
  for (const label of labels) {
    counts[label] = (counts[label] || 0) + 1;
  }

  const total = labels.length || 1;
  const classCount = orderedLabels.length || 1;
  return Object.fromEntries(orderedLabels.map((label) => [label, total / Math.max((counts[label] || 0) * classCount, 1)]));
}

function createRandomMatrix(rows, columns, random) {
  const scale = Math.sqrt(2 / Math.max(columns, 1));
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => (random() * 2 - 1) * scale * 0.15));
}

function trainSoftmaxClassifier(featureMatrix, labels, orderedLabels, hiddenSize, random) {
  const classCount = orderedLabels.length;
  const featureCount = featureMatrix[0].length;
  const classWeights = buildClassWeights(labels, orderedLabels);
  const hiddenWeights = createRandomMatrix(hiddenSize, featureCount, random);
  const hiddenBiases = zeros(hiddenSize);
  const outputWeights = createRandomMatrix(classCount, hiddenSize, random);
  const outputBiases = zeros(classCount);

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const hiddenWeightGradients = Array.from({ length: hiddenSize }, () => zeros(featureCount));
    const hiddenBiasGradients = zeros(hiddenSize);
    const outputWeightGradients = Array.from({ length: classCount }, () => zeros(hiddenSize));
    const outputBiasGradients = zeros(classCount);
    let totalWeight = 0;

    for (let rowIndex = 0; rowIndex < featureMatrix.length; rowIndex += 1) {
      const row = featureMatrix[rowIndex];
      const labelIndex = orderedLabels.indexOf(labels[rowIndex]);
      const sampleWeight = classWeights[labels[rowIndex]] || 1;
      const hiddenLinear = hiddenWeights.map((weights, hiddenIndex) => dot(weights, row) + hiddenBiases[hiddenIndex]);
      const hidden = hiddenLinear.map(relu);
      const logits = outputWeights.map((weights, classIndex) => dot(weights, hidden) + outputBiases[classIndex]);
      const probabilities = softmax(logits);
      totalWeight += sampleWeight;
      const outputErrors = zeros(classCount);
      const hiddenErrors = zeros(hiddenSize);

      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        const error = (probabilities[classIndex] - (classIndex === labelIndex ? 1 : 0)) * sampleWeight;
        outputErrors[classIndex] = error;
        outputBiasGradients[classIndex] += error;
        for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
          outputWeightGradients[classIndex][hiddenIndex] += error * hidden[hiddenIndex];
          hiddenErrors[hiddenIndex] += error * outputWeights[classIndex][hiddenIndex];
        }
      }

      for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
        if (hiddenLinear[hiddenIndex] <= 0) {
          continue;
        }
        const hiddenError = hiddenErrors[hiddenIndex];
        hiddenBiasGradients[hiddenIndex] += hiddenError;
        for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
          hiddenWeightGradients[hiddenIndex][featureIndex] += hiddenError * row[featureIndex];
        }
      }
    }

    for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
      for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
        const gradient =
          hiddenWeightGradients[hiddenIndex][featureIndex] / Math.max(totalWeight, 1) + L2 * hiddenWeights[hiddenIndex][featureIndex];
        hiddenWeights[hiddenIndex][featureIndex] -= LEARNING_RATE * gradient;
      }
      hiddenBiases[hiddenIndex] -= LEARNING_RATE * (hiddenBiasGradients[hiddenIndex] / Math.max(totalWeight, 1));
    }

    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
        const gradient =
          outputWeightGradients[classIndex][hiddenIndex] / Math.max(totalWeight, 1) + L2 * outputWeights[classIndex][hiddenIndex];
        outputWeights[classIndex][hiddenIndex] -= LEARNING_RATE * gradient;
      }
      outputBiases[classIndex] -= LEARNING_RATE * (outputBiasGradients[classIndex] / Math.max(totalWeight, 1));
    }
  }

  return {
    labels: orderedLabels,
    type: "mlp",
    hiddenWeights,
    hiddenBiases,
    outputWeights,
    outputBiases
  };
}

function predictStage(stage, featureVector, temperature = 1) {
  const hidden = (stage.hiddenWeights || []).map((weights, hiddenIndex) => relu(dot(weights, featureVector) + (stage.hiddenBiases?.[hiddenIndex] || 0)));
  const logits = (stage.outputWeights || []).map((weights, classIndex) => dot(weights, hidden) + (stage.outputBiases?.[classIndex] || 0));
  const probabilities = softmax(logits, temperature);
  return {
    logits,
    labels: stage.labels,
    probabilities
  };
}

function familyLabelFor(route) {
  return PHOTO_ROUTE_LABELS.includes(route) ? "photo_like" : "graphic_like";
}

function classifyWithModel(model, featureVector) {
  const family = predictStage(model.stages.family, featureVector, model.temperatures?.family || 1);
  const photo = predictStage(model.stages.photo, featureVector, model.temperatures?.photo || 1);
  const graphic = predictStage(model.stages.graphic, featureVector, model.temperatures?.graphic || 1);
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
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  return {
    route: ranked[0]?.[0] || "photo_general",
    confidence: ranked[0]?.[1] || 0,
    margin: (ranked[0]?.[1] || 0) - (ranked[1]?.[1] || 0),
    top2: ranked.slice(0, 2).map(([route]) => route),
    scores
  };
}

function crossEntropy(probabilities, labelIndex) {
  return -Math.log(Math.max(probabilities[labelIndex] || 1e-9, 1e-9));
}

function fitTemperature(stage, featureMatrix, labels) {
  if (!featureMatrix.length) {
    return 1;
  }

  let best = { temperature: 1, loss: Number.POSITIVE_INFINITY };
  for (let temperature = 0.5; temperature <= 3.0; temperature += 0.05) {
    let loss = 0;
    for (let index = 0; index < featureMatrix.length; index += 1) {
      const prediction = predictStage(stage, featureMatrix[index], temperature);
      const labelIndex = stage.labels.indexOf(labels[index]);
      loss += crossEntropy(prediction.probabilities, labelIndex);
    }
    if (loss < best.loss) {
      best = { temperature: Number(temperature.toFixed(2)), loss };
    }
  }
  return best.temperature;
}

function percentile(values, quantile) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = clamp(Math.floor((sorted.length - 1) * quantile), 0, sorted.length - 1);
  return sorted[position];
}

function buildRouteThresholds(results) {
  return Object.fromEntries(
    UPSCALE_ROUTES.map((route) => {
      const correct = results.filter((entry) => entry.expected === route && entry.predicted === route);
      if (!correct.length) {
        return [route, DEFAULT_GATING];
      }

      const confidence = clamp(percentile(correct.map((entry) => entry.confidence), 0.2) ?? DEFAULT_GATING.confidence, 0.65, 0.99);
      const margin = clamp(percentile(correct.map((entry) => entry.margin), 0.2) ?? DEFAULT_GATING.margin, 0.08, 0.45);
      return [route, { confidence, margin }];
    })
  );
}

async function ensureBackboneModel() {
  await ensureDir(path.dirname(backboneCachePath));
  await ensureDir(outputDir);
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

async function extractVisualFeatureVector(filePath) {
  try {
    return buildFeatureVector(await extractVisualFeatures(filePath)).map((value) => value * VISUAL_FEATURE_SCALE);
  } catch (_error) {
    return [];
  }
}

async function extractCombinedFeatures(filePath, capabilities, featureLayout = null) {
  const resnet = await extractResnetLogits(filePath, capabilities);
  if (!resnet?.length) {
    throw new Error(`Failed to extract backbone features for ${filePath}`);
  }

  let visual = await extractVisualFeatureVector(filePath);
  const expectedVisualCount = featureLayout?.visualCount ?? visual.length;
  if (visual.length !== expectedVisualCount) {
    if (visual.length < expectedVisualCount) {
      visual = [...visual, ...new Array(expectedVisualCount - visual.length).fill(0)];
    } else {
      visual = visual.slice(0, expectedVisualCount);
    }
  }

  return [...resnet, ...visual];
}

async function buildTrainingRows(samples, capabilities) {
  const rows = [];
  for (const sample of samples) {
    const filePath = await ensureSampleFile(sample.url, "train");
    const augmentedPaths = await ensureAugmentedImageSet(
      filePath,
      `${AUGMENTATION_VERSION}-${sample.route}-${path.basename(filePath, path.extname(filePath))}`,
      {
        profile: sample.route === "text_ui" ? "ui" : PHOTO_ROUTE_LABELS.includes(sample.route) ? "light" : "standard"
      }
    );
    for (const augmentedPath of augmentedPaths) {
      const visualFeatureVector = await extractVisualFeatureVector(augmentedPath);
      const featureVector = await extractCombinedFeatures(augmentedPath, capabilities);
      rows.push({
        route: sample.route,
        sourceId: sample.sourceId,
        filePath: augmentedPath,
        visualFeatureVector,
        featureVector
      });
    }
  }
  return rows;
}

async function buildEvaluationRows(samples, capabilities, bucket, featureLayout = null) {
  const rows = [];
  for (const sample of samples) {
    const filePath = await ensureSampleFile(sample.url, bucket);
    rows.push({
      id: sample.id || path.basename(filePath),
      route: sample.route,
      filePath,
      featureVector: await extractCombinedFeatures(filePath, capabilities, featureLayout)
    });
  }
  return rows;
}

async function buildFeedbackRows(feedbackPath, capabilities, featureLayout = null) {
  if (!feedbackPath) {
    return [];
  }

  let entries;
  try {
    entries = await readJsonLines(feedbackPath);
  } catch (_error) {
    return [];
  }

  const rows = [];
  for (const entry of entries) {
    const route = normalizeUpscaleRoute(entry.route ?? entry.label);
    if (!route || !entry.samplePath) {
      continue;
    }

    try {
      await fs.access(entry.samplePath);
      rows.push({
        route,
        sourceId: "feedback",
        filePath: entry.samplePath,
        visualFeatureVector: await extractVisualFeatureVector(entry.samplePath),
        featureVector: await extractCombinedFeatures(entry.samplePath, capabilities, featureLayout)
      });
    } catch (_error) {
      // Ignore stale feedback rows with missing sample artifacts.
    }
  }

  return rows;
}

function evaluateRows(model, rows) {
  const results = rows.map((row) => {
    const normalized = row.featureVector.map((value, index) => (value - model.featureMeans[index]) / model.featureScales[index]);
    const prediction = classifyWithModel(model, normalized);
    return {
      id: row.id || path.basename(row.filePath),
      expected: row.route,
      predicted: prediction.route,
      confidence: prediction.confidence,
      margin: prediction.margin,
      top2: prediction.top2
    };
  });

  return {
    results,
    metrics: buildMetrics(results)
  };
}

async function main() {
  const seed = Number.parseInt(process.env.STOUT_TRAINING_SEED || "20260410", 10);
  const random = createSeededRandom(seed);
  const trainSplit = await loadSplit("train", trainPath);
  const validationSplit = await loadSplit("validation", validationPath);
  const benchmarkSplit = await loadSplit("benchmark", benchmarkPath);
  const splitValidation = await validateDatasetSplits([trainSplit, validationSplit, benchmarkSplit]);
  const capabilities = await ensureBackboneModel();

  const manualRows = await buildTrainingRows(trainSplit.samples, capabilities);
  const feedbackRows = await buildFeedbackRows(process.env.STOW_ROUTER_FEEDBACK_PATH || "", capabilities);
  const trainingRows = [...manualRows, ...feedbackRows];
  if (trainingRows.length < UPSCALE_ROUTES.length) {
    throw new Error(`Not enough route-labeled rows to train a ${UPSCALE_ROUTES.length}-route model`);
  }

  const normalization = normalizeMatrix(trainingRows.map((row) => row.featureVector));
  const familyStage = trainSoftmaxClassifier(
    normalization.matrix,
    trainingRows.map((row) => familyLabelFor(row.route)),
    ROUTE_FAMILY_LABELS,
    HIDDEN_SIZES.family,
    random
  );
  const photoIndexes = trainingRows.map((row, index) => ({ row, index })).filter(({ row }) => PHOTO_ROUTE_LABELS.includes(row.route)).map(({ index }) => index);
  const graphicIndexes = trainingRows.map((row, index) => ({ row, index })).filter(({ row }) => GRAPHIC_ROUTE_LABELS.includes(row.route)).map(({ index }) => index);
  const photoStage = trainSoftmaxClassifier(
    photoIndexes.map((index) => normalization.matrix[index]),
    photoIndexes.map((index) => trainingRows[index].route),
    PHOTO_ROUTE_LABELS,
    HIDDEN_SIZES.photo,
    random
  );
  const graphicStage = trainSoftmaxClassifier(
    graphicIndexes.map((index) => normalization.matrix[index]),
    graphicIndexes.map((index) => trainingRows[index].route),
    GRAPHIC_ROUTE_LABELS,
    HIDDEN_SIZES.graphic,
    random
  );

  const validationRows = await buildEvaluationRows(
    validationSplit.samples,
    capabilities,
    "validation",
    {
      visualCount: manualRows[0]?.visualFeatureVector?.length || 0
    }
  );
  const normalizedValidation = validationRows.map((row) => row.featureVector.map((value, index) => (value - normalization.means[index]) / normalization.scales[index]));
  const familyTemperature = fitTemperature(familyStage, normalizedValidation, validationRows.map((row) => familyLabelFor(row.route)));
  const photoTemperature = fitTemperature(
    photoStage,
    normalizedValidation.filter((_, index) => PHOTO_ROUTE_LABELS.includes(validationRows[index].route)),
    validationRows.filter((row) => PHOTO_ROUTE_LABELS.includes(row.route)).map((row) => row.route)
  );
  const graphicTemperature = fitTemperature(
    graphicStage,
    normalizedValidation.filter((_, index) => GRAPHIC_ROUTE_LABELS.includes(validationRows[index].route)),
    validationRows.filter((row) => GRAPHIC_ROUTE_LABELS.includes(row.route)).map((row) => row.route)
  );

  const model = {
    version: 3,
    modelType: "hierarchical",
    labels: UPSCALE_ROUTES,
    featureLayout: {
      resnetCount: manualRows[0]?.featureVector.length ? manualRows[0].featureVector.length - (manualRows[0]?.visualFeatureVector?.length || 0) : 0,
      visualCount: manualRows[0]?.visualFeatureVector?.length || 0
    },
    featureMeans: normalization.means,
    featureScales: normalization.scales,
    temperatures: {
      family: familyTemperature,
      photo: photoTemperature,
      graphic: graphicTemperature
    },
    stages: {
      family: familyStage,
      photo: photoStage,
      graphic: graphicStage
    },
    trainingMetadata: {
      seed,
      splitFingerprints: splitValidation.fingerprints,
      splitCoverage: splitValidation.routeCoverage
    }
  };

  const validationEvaluation = evaluateRows(model, validationRows);
  model.gating = {
    defaultThresholds: DEFAULT_GATING,
    routeThresholds: buildRouteThresholds(validationEvaluation.results)
  };
  const benchmarkRows = await buildEvaluationRows(benchmarkSplit.samples, capabilities, "benchmark", model.featureLayout);
  const benchmarkEvaluation = evaluateRows(model, benchmarkRows);

  const report = {
    generatedAt: new Date().toISOString(),
    modelVersion: model.version,
    training: {
      seed,
      rows: trainingRows.length,
      manualRows: manualRows.length,
      feedbackRows: feedbackRows.length,
      routeCoverage: {
        train: splitValidation.routeCoverage.train,
        validation: splitValidation.routeCoverage.validation,
        benchmark: splitValidation.routeCoverage.benchmark
      },
      splitFingerprints: splitValidation.fingerprints
    },
    validation: validationEvaluation.metrics,
    benchmark: benchmarkEvaluation.metrics
  };

  await ensureDir(outputDir);
  await fs.writeFile(outputPath, JSON.stringify(model, null, 2));
  await ensureDir(path.dirname(cacheReportPath));
  await fs.writeFile(cacheReportPath, JSON.stringify(report, null, 2));

  process.stdout.write(renderMetricsReport("Stout Upscale Router Training Report", "benchmark", benchmarkSplit.samples, splitValidation, benchmarkEvaluation.metrics, benchmarkEvaluation.results));
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createSeededRandom
};
