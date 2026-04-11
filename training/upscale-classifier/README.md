# Upscale Router Dataset

This folder is the start of a real training path for the automatic upscaler router.

The goal is not to train a giant vision model from scratch. The goal is to train a small, reliable classifier that decides which upscaler family should handle a file:

- `photo_gentle` -> face-heavy or portrait-like photos; `realesrnet-x4plus`, then `realesrgan-x4plus`
- `photo_general` -> general real-world photos and wide scenes; `realesrgan-x4plus`
- `art_clean` -> illustration, posters, and non-anime artwork; `waifu2x`, then `realCugan`, then anime ESRGAN
- `art_anime` -> anime and cel-shaded art; `realCugan`, then `waifu2x`, then anime ESRGAN
- `text_ui` -> screenshots, memes, receipts, and text-heavy graphics; `waifu2x`, then `realesrgan-x4plus`

## Why this exists

The current app now uses `Stout`, the distilled runtime router in the backend. The shipping path is:

- quantized `resnet-18` ONNX backbone at runtime
- a tiny hierarchical route head for `photo_gentle`, `photo_general`, `art_clean`, `art_anime`, and `text_ui`
- validation-derived temperature scaling and per-route acceptance thresholds
- manual routing only when Stout is unavailable, feature extraction fails, or the prediction is not trustworthy enough to auto-apply

## Source strategy

Use clean, documented sources first:

- Open Images for real photographs
- CC0/open museum collections for artwork and illustration
- Wikimedia Commons with strict per-file license filtering

Treat anime-specific sources separately:

- Danbooru is the strongest practical anime-tag source, but it is not a clean default for commercial training.
- Use it only if you explicitly accept that risk.

## How to use

Generate the current plan and normalized manifest:

```bash
npm run dataset:upscale-router
```

Write the normalized manifest and print its path:

```bash
npm run dataset:upscale-router -- manifest
```

The generated manifest is written under `training-cache/upscale-classifier/manifest.json`.

Train the Stout router head:

```bash
npm run train:upscale-router
```

This validates the train/validation/benchmark splits for exact URL overlap, normalized URL overlap, and duplicate cached content hashes before training. The training report is written to `training-cache/upscale-classifier/distillation-report.json`.

Run the current Stout runtime benchmark:

```bash
npm run bench:upscale-router
```

Prune cached files that are no longer referenced by the active split manifests:

```bash
npm run prune:upscale-router
```

## Recommended next steps

1. Build a downloader per approved source that stores raw metadata, not just images.
2. Keep license, attribution, and source ids with every sample.
3. Expand validation and benchmark coverage before loosening acceptance thresholds.
4. Use the model itself plus manual review to trim mislabeled samples.
5. Keep the runtime conservative until held-out route accuracy is strong on real archive examples.
