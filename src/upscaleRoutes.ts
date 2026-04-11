export type UpscaleRoute = "photo_gentle" | "photo_general" | "art_clean" | "art_anime" | "text_ui";

export const UPSCALE_ROUTES: UpscaleRoute[] = ["photo_gentle", "photo_general", "art_clean", "art_anime", "text_ui"];

export const UPSCALE_ROUTE_LABELS: Record<UpscaleRoute, string> = {
  photo_gentle: "Photo gentle",
  photo_general: "Photo general",
  art_clean: "Artwork clean",
  art_anime: "Artwork anime",
  text_ui: "Text and UI"
};

export const UPSCALE_ROUTE_DESCRIPTIONS: Record<UpscaleRoute, string> = {
  photo_gentle: "Face-heavy or portrait-like photos. Uses the gentler photo model first.",
  photo_general: "General real-world photos, landscapes, and wide scenes.",
  art_clean: "Illustration, posters, graphic art, and other non-anime artwork.",
  art_anime: "Anime and cel-shaded artwork.",
  text_ui: "Screenshots, UI, receipts, memes, and text-heavy graphics."
};

export function getUpscaleRouteLabel(route: UpscaleRoute) {
  return UPSCALE_ROUTE_LABELS[route];
}

export function getUpscaleRouteDescription(route: UpscaleRoute) {
  return UPSCALE_ROUTE_DESCRIPTIONS[route];
}
