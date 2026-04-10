const fs = require("node:fs/promises");
const path = require("node:path");

const { extractResnetLogits } = require("../../backend/resnetBackbone");
const { extractVisualFeatures, buildFeatureVector } = require("../../backend/visualFeatures");
const { ensureAugmentedImageSet, ensureDir, ensureSampleFile, readJson, readJsonLines } = require("./sampleUtils");

const rootDir = path.resolve(__dirname, "..", "..");
const benchmarkPath = path.join(__dirname, "benchmark-samples.json");
const labeledTrainPath = path.join(__dirname, "labeled-train.json");
const outputDir = path.join(rootDir, "backend", "generated");
const outputPath = path.join(outputDir, "upscaleClassifierWeights.json");
const bundledBackbonePath = path.join(outputDir, "model_quantized.onnx");
const cacheReportPath = path.join(rootDir, "training-cache", "upscale-classifier", "distillation-report.json");
const backboneCachePath = path.join(rootDir, "training-cache", "upscale-classifier", "resnet18", "model_quantized.onnx");

const LABELS = ["portrait", "landscape", "photo", "illustration", "anime", "ui_screenshot"];
const PHOTO_LABELS = ["portrait", "landscape", "photo"];
const SYNTHETIC_LABELS = ["illustration", "anime", "ui_screenshot"];
const FAMILY_LABELS = ["photo_family", "synthetic_family"];
const EPOCHS = 300;
const LEARNING_RATE = 0.03;
const L2 = 0.0003;
const BACKBONE_URL = "https://huggingface.co/Xenova/resnet-18/resolve/main/onnx/model_quantized.onnx";
const AUGMENTATION_VERSION = "v2";
const VISUAL_FEATURE_SCALE = 0.35;
const HIDDEN_SIZES = {
  family: 24,
  photo: 48,
  synthetic: 32
};
const AUGMENT_REPEAT_BY_LABEL = {
  portrait: 1,
  landscape: 1,
  photo: 1,
  illustration: 1,
  anime: 2,
  ui_screenshot: 1
};

const AUGMENT_PROFILE_BY_LABEL = {
  portrait: "light",
  landscape: "light",
  photo: "light",
  illustration: "standard",
  anime: "standard",
  ui_screenshot: "ui"
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

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0) || 1;
  return exps.map((value) => value / total);
}

function relu(value) {
  return value > 0 ? value : 0;
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
  return Object.fromEntries(
    orderedLabels.map((label) => [label, total / Math.max((counts[label] || 0) * classCount, 1)])
  );
}

function createRandomMatrix(rows, columns) {
  const scale = Math.sqrt(2 / Math.max(columns, 1));
  return Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => (Math.random() * 2 - 1) * scale * 0.15)
  );
}

function trainSoftmaxClassifier(featureMatrix, labels, orderedLabels, hiddenSize = 0) {
  const classCount = orderedLabels.length;
  const featureCount = featureMatrix[0].length;
  const classWeights = buildClassWeights(labels, orderedLabels);

  if (!hiddenSize) {
    const weights = Array.from({ length: classCount }, () => zeros(featureCount));
    const biases = zeros(classCount);

    for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
      const weightGradients = Array.from({ length: classCount }, () => zeros(featureCount));
      const biasGradients = zeros(classCount);
      let totalWeight = 0;

      for (let rowIndex = 0; rowIndex < featureMatrix.length; rowIndex += 1) {
        const row = featureMatrix[rowIndex];
        const labelIndex = orderedLabels.indexOf(labels[rowIndex]);
        const sampleWeight = classWeights[labels[rowIndex]] || 1;
        const logits = weights.map((classWeights, classIndex) => dot(classWeights, row) + biases[classIndex]);
        const probabilities = softmax(logits);
        totalWeight += sampleWeight;

        for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
          const error = (probabilities[classIndex] - (classIndex === labelIndex ? 1 : 0)) * sampleWeight;
          biasGradients[classIndex] += error;
          for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
            weightGradients[classIndex][featureIndex] += error * row[featureIndex];
          }
        }
      }

      for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        for (let featureIndex = 0; featureIndex < featureCount; featureIndex += 1) {
          const gradient =
            weightGradients[classIndex][featureIndex] / Math.max(totalWeight, 1) + L2 * weights[classIndex][featureIndex];
          weights[classIndex][featureIndex] -= LEARNING_RATE * gradient;
        }
        biases[classIndex] -= LEARNING_RATE * (biasGradients[classIndex] / Math.max(totalWeight, 1));
      }
    }

    return { labels: orderedLabels, weights, biases, type: "linear" };
  }

  const hiddenWeights = createRandomMatrix(hiddenSize, featureCount);
  const hiddenBiases = zeros(hiddenSize);
  const outputWeights = createRandomMatrix(classCount, hiddenSize);
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

function predictStageModel(stage, featureVector) {
  if (stage.type === "mlp") {
    const hidden = (stage.hiddenWeights || []).map((weights, hiddenIndex) => relu(dot(weights, featureVector) + (stage.hiddenBiases?.[hiddenIndex] || 0)));
    const logits = (stage.outputWeights || []).map((weights, classIndex) => dot(weights, hidden) + (stage.outputBiases?.[classIndex] || 0));
    return softmax(logits);
  }

  const logits = (stage.weights || []).map((weights, classIndex) => dot(weights, featureVector) + (stage.biases?.[classIndex] || 0));
  return softmax(logits);
}

function predict(model, featureVector) {
  if (model.modelType === "hierarchical" && model.stages) {
    const family = model.stages.family;
    const photo = model.stages.photo;
    const synthetic = model.stages.synthetic;
    const familyProbabilities = predictStageModel(family, featureVector);
    const photoProbabilities = predictStageModel(photo, featureVector);
    const syntheticProbabilities = predictStageModel(synthetic, featureVector);

    const familyScores = Object.fromEntries(family.labels.map((label, index) => [label, familyProbabilities[index] || 0]));
    const scores = {
      portrait: familyScores.photo_family * (photoProbabilities[photo.labels.indexOf("portrait")] || 0),
      landscape: familyScores.photo_family * (photoProbabilities[photo.labels.indexOf("landscape")] || 0),
      photo: familyScores.photo_family * (photoProbabilities[photo.labels.indexOf("photo")] || 0),
      illustration: familyScores.synthetic_family * (syntheticProbabilities[synthetic.labels.indexOf("illustration")] || 0),
      anime: familyScores.synthetic_family * (syntheticProbabilities[synthetic.labels.indexOf("anime")] || 0),
      ui_screenshot: familyScores.synthetic_family * (syntheticProbabilities[synthetic.labels.indexOf("ui_screenshot")] || 0)
    };
    const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
    return {
      category: ranked[0]?.[0] || "photo",
      confidence: ranked[0]?.[1] || 0,
      probabilities: scores
    };
  }

  const logits = model.weights.map((weights, classIndex) => dot(weights, featureVector) + model.biases[classIndex]);
  const probabilities = softmax(logits);
  const bestIndex = probabilities.reduce((best, value, index) => (value > probabilities[best] ? index : best), 0);
  const labels = model.labels || LABELS;
  return {
    category: labels[bestIndex],
    confidence: probabilities[bestIndex],
    probabilities: Object.fromEntries(labels.map((label, index) => [label, probabilities[index]]))
  };
}

function familyLabelFor(label) {
  return PHOTO_LABELS.includes(label) ? "photo_family" : "synthetic_family";
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

async function buildLabeledRows(samples, capabilities) {
  const rows = [];
  for (const sample of samples) {
    const filePath = await ensureSampleFile(sample.url, "labeled-train");
    const repeats = AUGMENT_REPEAT_BY_LABEL[sample.label] || 1;
    const augmentedPaths = await ensureAugmentedImageSet(filePath, `${AUGMENTATION_VERSION}-${sample.label}-${path.basename(filePath, path.extname(filePath))}`, {
      profile: AUGMENT_PROFILE_BY_LABEL[sample.label] || "standard"
    });
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const augmentedPath of augmentedPaths) {
        const visualFeatureVector = await extractVisualFeatureVector(augmentedPath);
        const featureVector = await extractCombinedFeatures(augmentedPath, capabilities);
        rows.push({
          url: sample.url,
          filePath: augmentedPath,
          label: sample.label,
          teacherConfidence: 1,
          source: "manual",
          visualFeatureVector,
          featureVector
        });
      }
    }
  }
  return rows;
}

async function evaluateBenchmark(model, benchmarkSamples) {
  const results = [];
  const capabilities = await ensureBackboneModel();

  for (const sample of benchmarkSamples) {
    const filePath = await ensureSampleFile(sample.url, "benchmarks");
    const rawVector = await extractCombinedFeatures(filePath, capabilities, model.featureLayout);
    const normalized = rawVector.map((value, index) => (value - model.featureMeans[index]) / model.featureScales[index]);
    const prediction = predict(model, normalized);
    results.push({
      id: sample.id,
      expected: sample.label,
      predicted: prediction.category,
      confidence: prediction.confidence
    });
  }

  const correct = results.filter((entry) => entry.expected === entry.predicted).length;
  return {
    accuracy: correct / Math.max(results.length, 1),
    correct,
    total: results.length,
    results
  };
}

function renderSummary(report) {
  const lines = [];
  lines.push("Distilled Upscale Router");
  lines.push("");
  lines.push(`Training rows: ${report.training.rows}`);
  lines.push(`Manual seed rows: ${report.training.manualRows}`);
  lines.push(`Manual source images: ${report.training.manualSources}`);
  lines.push(`Feedback rows: ${report.training.feedbackRows}`);
  lines.push(`CLIP supplement rows: ${report.training.teacherRows}`);
  lines.push(`Teacher distribution: ${JSON.stringify(report.training.distribution)}`);
  lines.push("");
  lines.push(`Benchmark accuracy: ${(report.benchmark.accuracy * 100).toFixed(1)}% (${report.benchmark.correct}/${report.benchmark.total})`);
  lines.push("");
  for (const entry of report.benchmark.results) {
    lines.push(`- ${entry.id}: expected=${entry.expected} predicted=${entry.predicted} confidence=${Math.round(entry.confidence * 100)}%`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const benchmarkSamples = await readJson(benchmarkPath);
  const labeledTrainSamples = await readJson(labeledTrainPath);
  const capabilities = await ensureBackboneModel();
  const manualRows = await buildLabeledRows(labeledTrainSamples, capabilities);
  const feedbackRows = await buildFeedbackRows(process.env.STOW_ROUTER_FEEDBACK_PATH || "", capabilities);
  const trainingRows = [...manualRows, ...feedbackRows];

  if (trainingRows.length < LABELS.length) {
    throw new Error(`Not enough teacher-labeled rows to train a ${LABELS.length}-class model`);
  }

  const distribution = Object.fromEntries(LABELS.map((label) => [label, trainingRows.filter((row) => row.label === label).length]));
  const normalization = normalizeMatrix(trainingRows.map((row) => row.featureVector));
  const familyStage = trainSoftmaxClassifier(
    normalization.matrix,
    trainingRows.map((row) => familyLabelFor(row.label)),
    FAMILY_LABELS,
    HIDDEN_SIZES.family
  );
  const photoIndexes = trainingRows.map((row, index) => ({ row, index })).filter(({ row }) => PHOTO_LABELS.includes(row.label)).map(({ index }) => index);
  const syntheticIndexes = trainingRows.map((row, index) => ({ row, index })).filter(({ row }) => SYNTHETIC_LABELS.includes(row.label)).map(({ index }) => index);
  const photoStage = trainSoftmaxClassifier(
    photoIndexes.map((index) => normalization.matrix[index]),
    photoIndexes.map((index) => trainingRows[index].label),
    PHOTO_LABELS,
    HIDDEN_SIZES.photo
  );
  const syntheticStage = trainSoftmaxClassifier(
    syntheticIndexes.map((index) => normalization.matrix[index]),
    syntheticIndexes.map((index) => trainingRows[index].label),
    SYNTHETIC_LABELS,
    HIDDEN_SIZES.synthetic
  );

  const model = {
    version: 2,
    modelType: "hierarchical",
    labels: LABELS,
    featureLayout: {
      resnetCount: manualRows[0]?.featureVector.length ? manualRows[0].featureVector.length - (manualRows[0]?.visualFeatureVector?.length || 0) : 0,
      visualCount: manualRows[0]?.visualFeatureVector?.length || 0
    },
    featureMeans: normalization.means,
    featureScales: normalization.scales,
    stages: {
      family: familyStage,
      photo: photoStage,
      synthetic: syntheticStage
    }
  };

  const benchmark = await evaluateBenchmark(model, benchmarkSamples);
  const report = {
    generatedAt: new Date().toISOString(),
    training: {
      rows: trainingRows.length,
      manualRows: manualRows.length,
      manualSources: new Set(labeledTrainSamples.map((sample) => sample.url)).size,
      feedbackRows: feedbackRows.length,
      teacherRows: 0,
      distribution
    },
    benchmark
  };

  await ensureDir(outputDir);
  await fs.writeFile(outputPath, JSON.stringify(model, null, 2));
  await ensureDir(path.dirname(cacheReportPath));
  await fs.writeFile(cacheReportPath, JSON.stringify(report, null, 2));

  process.stdout.write(renderSummary(report));
}

async function buildFeedbackRows(feedbackPath, capabilities) {
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
    if (!LABELS.includes(entry.label) || !entry.samplePath) {
      continue;
    }

    try {
      await fs.access(entry.samplePath);
      const featureVector = await extractCombinedFeatures(entry.samplePath, capabilities);
      const visualFeatureVector = await extractVisualFeatureVector(entry.samplePath);
      rows.push({
        url: entry.samplePath,
        filePath: entry.samplePath,
        label: entry.label,
        teacherConfidence: 1,
        source: "feedback",
        visualFeatureVector,
        featureVector
      });
    } catch (_error) {
      // Ignore stale feedback rows with missing sample artifacts.
    }
  }

  return rows;
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
  if (featureLayout?.visualCount && visual.length !== featureLayout.visualCount) {
    if (visual.length < featureLayout.visualCount) {
      visual = [...visual, ...new Array(featureLayout.visualCount - visual.length).fill(0)];
    } else {
      visual = visual.slice(0, featureLayout.visualCount);
    }
  }

  return [...resnet, ...visual];
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
