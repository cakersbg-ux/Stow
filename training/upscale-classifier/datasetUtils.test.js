const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { validateDatasetSplits } = require("./datasetUtils");

test("dataset split validation catches exact, normalized, and hash overlaps", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stout-split-test-"));
  try {
    const alpha = path.join(tempDir, "alpha.png");
    const alphaCopy = path.join(tempDir, "alpha-copy.png");
    const beta = path.join(tempDir, "beta.png");
    await fs.writeFile(alpha, "alpha");
    await fs.writeFile(alphaCopy, "alpha");
    await fs.writeFile(beta, "beta");

    await assert.rejects(
      () =>
        validateDatasetSplits(
          [
            {
              name: "train",
              samples: [{ route: "photo_general", url: alpha, sourceId: "local", license: "local", attribution: "local" }]
            },
            {
              name: "validation",
              samples: [{ route: "photo_general", url: alpha, sourceId: "local", license: "local", attribution: "local" }]
            }
          ],
          { resolveSampleFile: async (url) => url }
        ),
      /overlap/
    );

    await assert.rejects(
      () =>
        validateDatasetSplits(
          [
            {
              name: "train",
              samples: [
                {
                  route: "photo_general",
                  url: "https://example.com/foo_small.png",
                  sourceId: "remote",
                  license: "x",
                  attribution: "x"
                }
              ]
            },
            {
              name: "validation",
              samples: [
                {
                  route: "photo_general",
                  url: "https://example.com/foo.png",
                  sourceId: "remote",
                  license: "x",
                  attribution: "x"
                }
              ]
            }
          ],
          { resolveSampleFile: async (_url, bucket) => (bucket === "train-validation" ? alpha : beta) }
        ),
      /overlap/
    );

    await assert.rejects(
      () =>
        validateDatasetSplits(
          [
            {
              name: "train",
              samples: [{ route: "photo_general", url: "https://example.com/a.png", sourceId: "remote", license: "x", attribution: "x" }]
            },
            {
              name: "validation",
              samples: [{ route: "art_clean", url: "https://example.com/b.png", sourceId: "remote", license: "x", attribution: "x" }]
            }
          ],
          {
            resolveSampleFile: async (url) => (url.endsWith("a.png") ? alpha : alphaCopy)
          }
        ),
      /overlap/
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
