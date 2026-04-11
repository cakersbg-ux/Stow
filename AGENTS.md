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
- `Stow` and `Stow Framework` are separate projects.
- `Stow Framework` is derived from `Stow`.

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

### Notes

- Search with `rg` when possible.
- Use `apply_patch` for manual file edits.
- Keep generated output and build artifacts out of version control unless there is a strong reason otherwise.
- The repo currently includes a `README.md` deletion in the working tree; do not assume it is part of this task.
- There is no upscaling-specific ML workflow in this repository anymore.
