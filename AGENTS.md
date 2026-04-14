# AGENTS

This is the single workspace instruction file for this repo.

## Standing Rules

- Keep `.gitignore` updated when a change introduces a clearly beneficial repo-specific ignore rule.
- Prefer targeted, minimal changes.
- Do not overwrite unrelated user work.
- Treat this file as the place for durable repo rules, operational notes, and current workspace facts.
- Stow must work on macOS and Windows at minimum. Do not introduce platform-specific UI patterns (e.g. macOS vibrancy, platform-specific fonts) without a cross-platform fallback. Keyboard shortcuts must handle both Cmd (macOS) and Ctrl (Windows).

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
- `npm run test:frontend` runs the pure frontend archive-model tests.
- `npm run bench:backend` runs backend benchmarks.

### Notes

- Search with `rg` when possible.
- Use `apply_patch` for manual file edits.
- Keep generated output and build artifacts out of version control unless there is a strong reason otherwise.
- The repo currently includes a `README.md` deletion in the working tree; do not assume it is part of this task.
- There is no upscaling-specific ML workflow in this repository anymore.
- Archive root metadata now stores only archive optimization preferences; app-local defaults stay in `settings.json`.
- Reprocessing should use the stored original artifact instead of relying on a host filesystem source path.
- Shared archive/session policy normalization now lives in `backend/policies.js`.
- Background tooling setup should not block normal daemon interactions; external tool probes/installs are timeout-bounded.
- Recent archives are now a persisted recency index in `user-data/recent-archives.json`, separate from detected archives.
- Metadata/settings writes use atomic temp-write-and-rename helpers from `backend/atomicFile.js`.
- The Tauri `archives_list_detected` command now proxies to the backend daemon instead of keeping a second Rust-side scan implementation.
- The daemon now prefers `settings.preferredArchiveRoot` when resolving detected-archive scan scope, falling back to `defaultArchiveRoot` rather than `homeDir`.
- Archive roots now persist explicit `folders` metadata so unlocked archives can represent empty folders and directory navigation independently from file entries.
- The app now has a persistent `Hub` home view, and `settings.themePreference` persists `system`, `light`, or `dark` UI theming.
- Image uploads whose extensions are recognized but unsupported by the bundled Sharp decoder (for example `.jxl`) are ingested as opaque files instead of failing the import path.
- When `djxl` is available, JPEG XL uploads are treated as images and decoded through libjxl for metadata and preview generation while preserving the original `.jxl` artifact.
- Archive-internal metadata paths are code-owned in `backend/archivePathSafety.js`; unsafe manifest/catalog/object metadata is rejected instead of being trusted for filesystem resolution.
- Backend startup now performs tooling detection only; explicit runtime-tool installation is separate from daemon bootstrap.
- Archive entry listing now accepts backend-owned sort parameters and applies ordering before pagination so the UI can render visible order directly.
- Media subprocess calls in `backend/mediaTools.js` are timeout-bounded so blocked ffmpeg/ffprobe/cjxl/djxl invocations fail instead of hanging indefinitely.
- Production Tauri builds now stage a bundled Node runtime into `src-tauri/resources/node-runtime/`, and release startup prefers that bundled runtime with system-node fallback disabled unless explicitly re-enabled.
- Detected archive scans now use a persisted `detected-archives.json` cache keyed to the scanned home root and root-directory snapshot so fresh scans can avoid repeated deep traversal.
- Unlocked archive sessions now persist an encrypted `catalog/entry-summary.enc` summary index; `backend/archiveQueryIndex.js` serves warm sorted/paginated listings and path lookups from that summary cache instead of reopening every entry catalog.
- Archive mutations now route through a shared `executeMutationTransaction` boundary in `backend/archiveService.js`, backed by `backend/archiveMutationTransaction.js`, so `persistRoot()` is the commit point and persist failures restore tracked entry catalogs plus session/query state coherently.
- Metadata mutations now persist an encrypted `catalog/mutation-journal.enc` before overwriting entry catalogs; `openArchive()` reconciles leftover journals so interrupted rename/move/create/delete metadata does not get trusted blindly on reopen, while stale journals from already-committed roots are cleared.
- Automatic runtime-tool installation is now limited to trusted managed installers on Windows; package-manager candidates remain detectable but are refused by the automatic install path with manual-install guidance.
- Bundled release Node runtime staging now writes `src-tauri/resources/node-runtime/runtime-metadata.json`, and Tauri release startup validates the staged runtime’s hash/version against that metadata before launch; untrusted override/fallback paths require explicit opt-in.
- `backend/archiveQueryIndex.js` now caches warm sorted directory listings per directory/sort tuple and invalidates that cache on rebuild, so repeated list reads slice cached snapshots instead of re-sorting each bucket.
- `backend/archiveQueryIndex.js` now bounds warm listing cache growth with a small LRU-style cap so browsing many directories does not accumulate unbounded cached snapshots.
- Catalog/object storage helpers now zeroize more decrypted transient buffers and clean up failed temp materialization directories best-effort, though JS string parsing still limits memory scrubbing to best effort.
- `backend/metadataStore.js` now provides the first JSON-backed metadata-store seam used by archive sessions for entry/root/summary/journal persistence, so future metadata backends can slot in behind the same interface.
- `backend/archiveNamePolicy.js` is the shared cross-platform archive path/name policy for archive creation, entry renames, and folder naming.
- The archive UI entrypoint is now `src/features/app/AppShell.tsx`, and `src/features/archive/archiveModel.ts` holds the pure page-cache, visible-order selection, and archive-browser merge/sort helpers.
- Runtime-tool installation is now explicit from the UI via `runtime:install-missing-tools`; backend startup remains detection-only.
- Shell subscriptions and archive session synchronization now live in `src/features/app/useShellStore.ts` and `src/features/archive/useArchiveSession.ts`.
- Archive presentation components now live in `src/features/app/AppShellComponents.tsx`, while `src/features/app/AppShell.tsx` focuses on shell orchestration/state wiring.
- Archive filesystem/process helpers used by ingest/open flows now live in `backend/archiveFs.js`, so `backend/archiveService.js` consumes them rather than inlining traversal/temp-dir/open helpers.
- Archive entry shaping and summary helpers now live in `backend/archiveEntryModel.js` and are consumed by `backend/archiveService.js`.
- `backend/metadataStore.js` now includes an opt-in SQLite adapter (`STOW_METADATA_STORE=sqlite`) behind `createMetadataStore(...)`, with JSON remaining the default.
- Archive upload queueing and archive-browser state orchestration are split into `src/features/app/useUploadQueue.ts` and `src/features/app/useArchiveBrowser.ts`.
