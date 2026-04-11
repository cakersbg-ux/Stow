const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyFeatureVectorWithModel, classificationPassesGate } = require("./distilledClassifier");

function createHierarchicalModel(temperatures = {}) {
  return {
    modelType: "hierarchical",
    temperatures,
    gating: {
      defaultThresholds: {
        confidence: 0.75,
        margin: 0.2
      }
    },
    stages: {
      family: {
        labels: ["photo_like", "graphic_like"],
        weights: [[2], [-2]],
        biases: [0, 0]
      },
      photo: {
        labels: ["photo_gentle", "photo_general"],
        weights: [[1], [-1]],
        biases: [0, 0]
      },
      graphic: {
        labels: ["art_clean", "art_anime", "text_ui"],
        weights: [[0], [0], [0]],
        biases: [0, 0, 0]
      }
    }
  };
}

test("hierarchical inference applies stored temperatures to route confidence", () => {
  const coldModel = createHierarchicalModel({ family: 0.5, photo: 0.5, graphic: 1 });
  const warmModel = createHierarchicalModel({ family: 2, photo: 2, graphic: 1 });

  const cold = classifyFeatureVectorWithModel(coldModel, [1]);
  const warm = classifyFeatureVectorWithModel(warmModel, [1]);

  assert.equal(cold.route, "photo_gentle");
  assert.equal(warm.route, "photo_gentle");
  assert.ok(cold.confidence > warm.confidence);
});

test("classification gate rejects high-confidence routes when the margin is too small", () => {
  const model = {
    gating: {
      defaultThresholds: {
        confidence: 0.8,
        margin: 0.18
      }
    }
  };

  assert.equal(
    classificationPassesGate(model, {
      route: "photo_general",
      confidence: 0.93,
      scores: {
        photo_general: 0.93,
        photo_gentle: 0.9,
        art_clean: 0.01,
        art_anime: 0.01,
        text_ui: 0.01
      }
    }),
    false
  );

  assert.equal(
    classificationPassesGate(model, {
      route: "photo_general",
      confidence: 0.93,
      scores: {
        photo_general: 0.93,
        photo_gentle: 0.5,
        art_clean: 0.03,
        art_anime: 0.02,
        text_ui: 0.02
      }
    }),
    true
  );
});
