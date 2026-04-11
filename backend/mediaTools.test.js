const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAutomaticUpscaleProfiles,
  buildVideoFilterChain,
  buildRealCuganArgs,
  buildRealEsrganArgs,
  buildWaifu2xArgs,
  formatFps,
  parseFrameRate,
  resolveInterpolationTargetFps,
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

test("parseFrameRate handles rational and decimal frame rates", () => {
  assert.equal(parseFrameRate("24000/1001"), 24000 / 1001);
  assert.equal(parseFrameRate("60"), 60);
  assert.equal(parseFrameRate("0/0"), null);
  assert.equal(parseFrameRate(""), null);
});

test("resolveInterpolationTargetFps only enables interpolation above source fps", () => {
  const stream = {
    avg_frame_rate: "24000/1001",
    r_frame_rate: "24000/1001"
  };
  assert.equal(resolveInterpolationTargetFps(stream, "off"), null);
  assert.equal(resolveInterpolationTargetFps(stream, "30"), 30);
  assert.equal(resolveInterpolationTargetFps(stream, "60"), 60);
  assert.equal(resolveInterpolationTargetFps(stream, "10"), null);
  assert.equal(resolveInterpolationTargetFps(stream, "garbage"), null);
});

test("buildVideoFilterChain supports upscale-only and interpolation-only paths", () => {
  const upscaleAndInterpolate = buildVideoFilterChain({ width: 1920, height: 1080 }, 60, true);
  assert.ok(upscaleAndInterpolate[0].startsWith("scale=1920:1080"));
  assert.ok(upscaleAndInterpolate.some((item) => item.startsWith("minterpolate=fps=60")));

  const interpolationOnly = buildVideoFilterChain({ width: 1920, height: 1080 }, 60, false);
  assert.equal(interpolationOnly[0], "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1");
  assert.equal(interpolationOnly[1], "format=yuv420p");

  const passthrough = buildVideoFilterChain({ width: 1920, height: 1080 }, null, false);
  assert.deepEqual(passthrough, []);
});

test("formatFps renders integer and decimal values", () => {
  assert.equal(formatFps(60), "60");
  assert.equal(formatFps(59.94), "59.94");
});

test("anime still images route to a specialist upscaler", () => {
  assert.equal(buildAutomaticUpscaleProfiles("art_anime", "image")[0].engine, "realCugan");
  assert.equal(buildAutomaticUpscaleProfiles("art_clean", "image")[0].engine, "waifu2x");
});

test("portrait routing still favors the gentler real-esrnet model first", () => {
  assert.equal(buildAutomaticUpscaleProfiles("photo_gentle", "image")[0].modelName, "realesrnet-x4plus");
});

test("anime and illustration video routes use the anime video model", () => {
  assert.equal(buildAutomaticUpscaleProfiles("art_anime", "video")[0].modelName, "realesr-animevideov3");
  assert.equal(buildAutomaticUpscaleProfiles("art_clean", "video")[0].modelName, "realesr-animevideov3");
});

test("text and ui route prefers waifu2x before photo upscalers", () => {
  const profiles = buildAutomaticUpscaleProfiles("text_ui", "image");
  assert.equal(profiles[0].engine, "waifu2x");
  assert.equal(profiles[1].modelName, "realesrgan-x4plus");
});
