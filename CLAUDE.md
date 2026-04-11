# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **See [AGENTS.md](./AGENTS.md) for the full workspace instructions**, including standing rules, repo layout, all `npm run` commands, and living notes about how this repo works.

## Stack Summary

- **Frontend**: Vite + React 19, TypeScript — lives in `src/`
- **Desktop shell**: Tauri 2 / Rust — lives in `src-tauri/`
- **Backend services**: Node.js (CommonJS) — lives in `backend/`
- **ML / training**: Node.js scripts — lives in `training/`

## Key Commands

| Task | Command |
|---|---|
| Run full app (dev) | `npm run dev` |
| Run frontend only | `npm run dev:web` |
| Run backend tests | `npm run test:backend` |
| Run backend benchmarks | `npm run bench:backend` |
| Build desktop app | `npm run build` |
