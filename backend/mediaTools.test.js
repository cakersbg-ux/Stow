const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAutomaticUpscaleProfiles,
  buildRealCuganArgs,
  buildRealEsrganArgs,
  buildWaifu2xArgs,
  selectUpscaleFactor,
  shouldUpscaleToTarget
} = require("./mediaTools");

test("shouldUpscaleToTarget only enables enlargement below the target tier", () => {
  assert.equal(shouldUpscaleToTarget(1280, 720, 1080), true);
  assert.equal(shouldUpscaleToTarget(1920, 1080, 1080), false);
  assert.equal(shouldUpscaleToTarget(3840, 2160, 1080), false);
});

test("selectUpscaleFactor chooses the smallest supported Real-ESRGAN factor that reaches the target", () => {
  assert.equal(selectUpscaleFactor(1280, 720, 1080), 2);
  assert.equal(selectUpscaleFactor(1280, 720, 2160), 3);
  assert.equal(selectUpscaleFactor(640, 360, 2160), 4);
  assert.equal(selectUpscaleFactor(1920, 1080, 1080), null);
});

test("buildRealEsrganArgs produces the expected command-line shape", () => {
  assert.deepEqual(
    buildRealEsrganArgs({
      inputPath: "/tmp/in.png",
      outputPath: "/tmp/out.png",
      scale: 3,
      modelName: "realesrgan-x4plus",
      modelPath: "/tmp/models"
    }),
    ["-i", "/tmp/in.png", "-o", "/tmp/out.png", "-s", "3", "-n", "realesrgan-x4plus", "-m", "/tmp/models", "-f", "png"]
  );
});

test("engine-specific argument builders include their model and denoise settings", () => {
  assert.deepEqual(
    buildRealCuganArgs({
      inputPath: "/tmp/in.png",
      outputPath: "/tmp/out.png",
      scale: 2,
      noiseLevel: -1,
      modelPath: "/tmp/models-se"
    }),
    ["-i", "/tmp/in.png", "-o", "/tmp/out.png", "-s", "2", "-n", "-1", "-m", "/tmp/models-se", "-f", "png"]
  );

  assert.deepEqual(
    buildWaifu2xArgs({
      inputPath: "/tmp/in.png",
      outputPath: "/tmp/out.png",
      scale: 4,
      noiseLevel: 0,
      modelPath: "/tmp/models-cunet"
    }),
    ["-i", "/tmp/in.png", "-o", "/tmp/out.png", "-s", "4", "-n", "0", "-m", "/tmp/models-cunet", "-f", "png"]
  );
});

test("selectUpscaleFactor respects the supported factors for a specific engine", () => {
  assert.equal(selectUpscaleFactor(1280, 720, 2160, [2, 4, 8]), 4);
  assert.equal(selectUpscaleFactor(960, 540, 1080, [2, 4, 8]), 2);
});

test("anime still images route to a specialist upscaler", () => {
  assert.equal(buildAutomaticUpscaleProfiles("anime", "image")[0].engine, "realCugan");
  assert.equal(buildAutomaticUpscaleProfiles("illustration", "image")[0].engine, "waifu2x");
});

test("portrait routing still favors the gentler real-esrnet model first", () => {
  assert.equal(buildAutomaticUpscaleProfiles("portrait", "image")[0].modelName, "realesrnet-x4plus");
});

test("anime and illustration video routes use the anime video model", () => {
  assert.equal(buildAutomaticUpscaleProfiles("anime", "video")[0].modelName, "realesr-animevideov3");
  assert.equal(buildAutomaticUpscaleProfiles("illustration", "video")[0].modelName, "realesr-animevideov3");
});
