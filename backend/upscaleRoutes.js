const UPSCALE_ROUTES = ["photo_gentle", "photo_general", "art_clean", "art_anime", "text_ui"];
const GRAPHIC_ROUTES = new Set(["art_clean", "art_anime", "text_ui"]);
const PHOTO_ROUTES = new Set(["photo_gentle", "photo_general"]);

const UPSCALE_ROUTE_LABELS = {
  photo_gentle: "Photo gentle",
  photo_general: "Photo general",
  art_clean: "Artwork clean",
  art_anime: "Artwork anime",
  text_ui: "Text and UI"
};

const UPSCALE_ROUTE_DESCRIPTIONS = {
  photo_gentle: "Face-heavy or portrait-like photos. Uses the gentler photo model first.",
  photo_general: "General real-world photos, landscapes, and wide scenes.",
  art_clean: "Illustration, posters, graphic art, and other non-anime artwork.",
  art_anime: "Anime and cel-shaded artwork.",
  text_ui: "Screenshots, UI, receipts, memes, and text-heavy graphics."
};

const LEGACY_LABEL_TO_ROUTE = {
  portrait: "photo_gentle",
  landscape: "photo_general",
  photo: "photo_general",
  illustration: "art_clean",
  anime: "art_anime",
  ui_screenshot: "text_ui"
};

function normalizeUpscaleRoute(value) {
  if (typeof value !== "string") {
    return null;
  }

  if (UPSCALE_ROUTES.includes(value)) {
    return value;
  }

  return LEGACY_LABEL_TO_ROUTE[value] || null;
}

function getUpscaleRouteLabel(route) {
  return UPSCALE_ROUTE_LABELS[route] || route;
}

function getUpscaleRouteDescription(route) {
  return UPSCALE_ROUTE_DESCRIPTIONS[route] || route;
}

function getUpscaleRouteFamily(route) {
  if (PHOTO_ROUTES.has(route)) {
    return "photo_like";
  }
  if (GRAPHIC_ROUTES.has(route)) {
    return "graphic_like";
  }
  return null;
}

module.exports = {
  GRAPHIC_ROUTES,
  LEGACY_LABEL_TO_ROUTE,
  PHOTO_ROUTES,
  UPSCALE_ROUTES,
  UPSCALE_ROUTE_DESCRIPTIONS,
  UPSCALE_ROUTE_LABELS,
  getUpscaleRouteDescription,
  getUpscaleRouteFamily,
  getUpscaleRouteLabel,
  normalizeUpscaleRoute
};
