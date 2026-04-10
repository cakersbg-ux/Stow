const fs = require("node:fs/promises");

const BROAD_PROMPTS = {
  anime: [
    "an anime or manga style drawing",
    "an animation frame from anime",
    "a cel-shaded anime illustration"
  ],
  illustration: [
    "an illustration or painting, not a photograph",
    "a poster, graphic art, or cover art image",
    "a print, drawing, or painted artwork"
  ],
  ui_screenshot: [
    "a software user interface screenshot",
    "a text-heavy document, invoice, or form image",
    "a meme, chart, or infographic style screenshot"
  ],
  photo: [
    "a real-world photograph",
    "a photo captured by a camera",
    "a realistic photo, not a drawing"
  ]
};

const PHOTO_PROMPTS = {
  portrait: [
    "a portrait photo of a real person",
    "a headshot or selfie photo",
    "a close photo focused on a person"
  ],
  landscape: [
    "a landscape photo of scenery or nature",
    "a travel photo of a city street, architecture, or wide outdoor scene",
    "a wide scenic photograph"
  ],
  photo: [
    "a general real-world photograph",
    "a candid everyday photo",
    "a non-portrait photo of the real world"
  ]
};

let classifierPromise = null;

function flattenPromptGroups(groups) {
  return Object.entries(groups).flatMap(([category, prompts]) => prompts.map((prompt) => ({ category, prompt })));
}

function collapseResults(flatPrompts, results) {
  const buckets = new Map();

  for (const item of flatPrompts) {
    buckets.set(item.category, []);
  }

  for (const result of results) {
    const match = flatPrompts.find((item) => item.prompt === result.label);
    if (!match) {
      continue;
    }
    buckets.get(match.category).push(result.score || 0);
  }

  const scores = {};
  for (const [category, values] of buckets.entries()) {
    scores[category] = values.length ? Math.max(...values) : 0;
  }

  return Object.entries(scores).sort((left, right) => right[1] - left[1]);
}

async function getClassifier() {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      try {
        const { env, pipeline } = await import("@huggingface/transformers");
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        return pipeline("zero-shot-image-classification", "Xenova/clip-vit-base-patch32");
      } catch (_error) {
        return null;
      }
    })();
  }
  return classifierPromise;
}

async function scorePromptGroups(filePath, promptGroups) {
  const classifier = await getClassifier();
  if (!classifier) {
    return null;
  }
  const flatPrompts = flattenPromptGroups(promptGroups);
  const results = await classifier(
    filePath,
    flatPrompts.map((item) => item.prompt)
  );
  return {
    ranking: collapseResults(flatPrompts, results),
    raw: results
  };
}

function asClassificationResult(category, confidence, scores, stageResults = {}) {
  return {
    category,
    confidence,
    scores,
    provider: "clip",
    debug: stageResults
  };
}

async function classifyImageWithClip(filePath) {
  await fs.access(filePath);

  const broad = await scorePromptGroups(filePath, BROAD_PROMPTS);
  if (!broad) {
    return null;
  }
  const broadScores = Object.fromEntries(broad.ranking);
  const [broadCategory, broadConfidence = 0] = broad.ranking[0] || ["photo", 0];

  if (broadCategory !== "photo") {
    return asClassificationResult(broadCategory, broadConfidence, broadScores, { broad: broad.raw });
  }

  const photo = await scorePromptGroups(filePath, PHOTO_PROMPTS);
  if (!photo) {
    return null;
  }
  const photoScores = Object.fromEntries(photo.ranking);
  const [photoCategory, photoConfidence = 0] = photo.ranking[0] || ["photo", 0];

  return asClassificationResult(photoCategory, photoConfidence, { ...broadScores, ...photoScores }, { broad: broad.raw, photo: photo.raw });
}

module.exports = {
  classifyImageWithClip
};
