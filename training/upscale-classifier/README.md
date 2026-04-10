# Upscale Router Dataset

This folder is the start of a real training path for the automatic upscaler router.

The goal is not to train a giant vision model from scratch. The goal is to train a small, reliable classifier that decides which upscaler family should handle a file:

- `portrait` -> Real-ESRGAN with the least destructive photo-oriented model
- `landscape` / `photo` -> Real-ESRGAN general model
- `illustration` / `anime` -> Real-CUGAN or waifu2x first
- `ui_screenshot` -> text-friendly/artwork-friendly path instead of blind photo restoration

## Why this exists

The current app now uses a distilled runtime router in the backend. The shipping path is:

- quantized `resnet-18` ONNX backbone at runtime
- a tiny trained classification head for `portrait`, `landscape`, `photo`, `illustration`, `anime`, and `ui_screenshot`
- the older heuristic router only as a fallback if the distilled model is unavailable or uncertain

CLIP is still useful, but now as a benchmarking and teacher/oracle tool rather than the default runtime dependency.

## Source strategy

Use clean, documented sources first:

- Open Images for real photographs
- CC0/open museum collections for art and illustration
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

Train the distilled router head:

```bash
npm run train:upscale-router
```

Run the current distilled runtime benchmark:

```bash
npm run bench:upscale-router
```

Run the CLIP oracle benchmark:

```bash
npm run bench:upscale-router:clip
```

## Recommended next steps

1. Build a downloader per approved source that stores raw metadata, not just images.
2. Keep license and attribution fields with every sample.
3. Use the model itself plus manual review to trim mislabeled samples.
4. Fine-tune a small image classifier head on top of a pretrained encoder.
5. Keep the current heuristic router as a fallback if the ML classifier is unavailable.
