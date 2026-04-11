# AGENTS

This is the single workspace instruction file for this repo.

## Standing Rules

- Keep `.gitignore` updated when a change introduces a clearly beneficial repo-specific ignore rule.
- Prefer targeted, minimal changes.
- Do not overwrite unrelated user work.
- Treat this file as the place for durable repo rules, operational notes, and current workspace facts.

## Living Repo Notes

Update this section whenever an agent learns something durable about how this repo works.

### Purpose

- `Stow` is a local-first desktop archiver with dedupe, compression, encryption, and media optimization.

### Layout

- `src/` contains the Vite/React frontend.
- `src-tauri/` contains the Tauri/Rust shell.
- `backend/` contains Node services, helpers, benchmarks, and tests.
- `training/` contains dataset and model-training scripts.
- `training-cache/` contains local training data and should remain untracked.

### Commands

- `npm run dev` starts the full Tauri app in development mode.
- `npm run dev:web` runs only the frontend with Vite.
- `npm run build` builds the desktop app.
- `npm run build:web` builds only the frontend bundle.
- `npm run test:backend` runs the Node test suite in `backend/`.
- `npm run bench:backend` runs backend benchmarks.
- `npm run dataset:upscale-router` curates the upscale-router dataset.
- `npm run train:upscale-router` trains the distilled upscale-router model.
- `npm run bench:upscale-router` benchmarks the shipped Stout route model on the held-out split.
- `npm run prune:upscale-router` removes stale cached training assets under `training-cache/upscale-classifier`.

### Notes

- Search with `rg` when possible.
- Use `apply_patch` for manual file edits.
- Keep generated output and build artifacts out of version control unless there is a strong reason otherwise.
- The repo currently includes a `README.md` deletion in the working tree; do not assume it is part of this task.
- Managed NCNN upscalers on macOS can be cwd-sensitive, so launch them from their install directory when probing or running them.
- Stout v3 is route-centric (`photo_gentle`, `photo_general`, `art_clean`, `art_anime`, `text_ui`) and uses explicit train/validation/benchmark manifests under `training/upscale-classifier/`.
- Runtime auto-routing is now conservative: Stout must clear validation-derived confidence and margin thresholds before Stow will apply a route automatically.
