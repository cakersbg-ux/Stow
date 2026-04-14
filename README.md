# Stow

Stow is a local-first desktop archive utility for files, images, and video. It keeps the UI deliberately plain and pushes the real work into a native-capable backend: archive manifests, chunk/object storage, dedupe, zstd compression, Argon2id password derivation, XChaCha20-Poly1305 secretstream encryption, image/video derivatives, and export.

## Stack

- Tauri for the desktop shell and native file access
- React + Vite for the restrained renderer UI
- Node daemon services for archive orchestration
- `zstd` CLI for object compression
- `cjxl` for JPEG XL image derivatives
- `ffmpeg-static` and `ffprobe-static` for video probing/transcoding
- `libsodium-wrappers-sumo` + `hash-wasm` for encryption and Argon2id
- `sharp` for image processing and unlocked-session previews

## Current MVP behavior

- Create a `.stow` archive from the app with archive-local password protection.
- Set global default preferences for image target resolution, video target resolution, compression behavior, optimization mode, metadata stripping, and Argon2 profile.
- Auto-install missing local tooling on macOS and Windows when supported.
- Open an existing archive by path and password.
- Reopen archives from the default Stow archive folder.
- Add files or whole folders. Folder ingest preserves relative paths.
- Store file data in content-defined chunked objects. Identical chunks are reused across entries and revisions.
- Apply compression after dedupe and encryption after compression.
- Keep originals for archival correctness and generate optimized derivatives when the chosen rules allow it.
- Generate JPEG XL derivatives for images when `cjxl` is present.
- Generate FFV1 archival masters or AV1 access copies for video when the source/tooling allows it.
- Reprocess a selected entry with a per-file override between lossless and visually lossless.
- Export either the preserved original or the latest optimized derivative.
- Open any selected entry in the operating system's default app without a manual export flow.

## Tooling expectations

- Required for the full archive pipeline: `zstd`
- Required for JPEG XL image derivatives: `cjxl`
- Optional for heavier offline compression mode: `7z`

The app detects these tools at runtime and shows their availability in the sidebar. Missing optional tools skip those optimization paths instead of blocking the archive.

## Run

```bash
npm install
npm run dev
```

For the desktop production bundle:

```bash
npm run build
```

## Archive layout

Each archive is a plain directory ending in `.stow`:

- `manifest.json`: password-wrapping metadata plus an encrypted catalog blob
- `objects/`: encrypted chunk objects stored under randomized ids

Preview images are generated only after unlock and are not stored inside the archive. Only `v3` archives are supported by the current build.

## Architecture note

- The desktop shell is Tauri (Rust + system webview).
- Archive/media/crypto logic remains in a persistent Node backend daemon (`backend/daemon.cjs`) to keep behavior equivalent to the original app.
- The Tauri layer proxies command calls and emits state updates to the React frontend.

## Notes

- The current implementation favors correctness and inspectability over aggressive hidden automation.
- Video behavior depends on the encoder support in the bundled ffmpeg build.
- “Pick per file” is implemented through post-ingest per-entry reprocessing.

## Workspace Notes

- `src/` contains the Vite/React frontend.
- `src-tauri/` contains the Tauri/Rust shell.
- `backend/` contains Node services, helpers, benchmarks, and tests.
- `training/` contains dataset and model-training scripts.
- `training-cache/` stays local-only and should remain untracked.
- Common commands: `npm run dev`, `npm run build`, `npm run test:backend`, `npm run test:frontend`, and `npm run bench:backend`.
