const test = require("node:test");
const assert = require("node:assert/strict");

const { getUpscaleRouteFamily, normalizeUpscaleRoute } = require("./upscaleRoutes");

test("legacy semantic labels map onto route labels", () => {
  assert.equal(normalizeUpscaleRoute("portrait"), "photo_gentle");
  assert.equal(normalizeUpscaleRoute("landscape"), "photo_general");
  assert.equal(normalizeUpscaleRoute("photo"), "photo_general");
  assert.equal(normalizeUpscaleRoute("illustration"), "art_clean");
  assert.equal(normalizeUpscaleRoute("anime"), "art_anime");
  assert.equal(normalizeUpscaleRoute("ui_screenshot"), "text_ui");
});

test("route families reflect photo versus graphic paths", () => {
  assert.equal(getUpscaleRouteFamily("photo_gentle"), "photo_like");
  assert.equal(getUpscaleRouteFamily("photo_general"), "photo_like");
  assert.equal(getUpscaleRouteFamily("art_clean"), "graphic_like");
  assert.equal(getUpscaleRouteFamily("art_anime"), "graphic_like");
  assert.equal(getUpscaleRouteFamily("text_ui"), "graphic_like");
});
