# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Xibo Player is a cross-platform Electron desktop app that connects to a Xibo CMS and plays digital signage layouts. It uses Vite for builds, TypeScript throughout, SQLite for local stats/logs, and an Express HTTP server to bridge local media files to the renderer.

## Commands

```bash
npm run dev        # Start dev server with HMR (remote debug on port 9222)
npm run build      # Build all processes via electron-vite
npm run start      # Preview built output
npm run package    # Build + electron-forge package
npm run make       # Build + electron-forge make (creates installers)
npm run rebuild    # Rebuild native modules (e.g. better-sqlite3 after Node version change)
```

There is no dedicated lint or test script. ESLint is configured in `.eslintrc.js` (extends electron-toolkit + Google style, 2-space indent, max 130 chars/line).

## Development Setup

This repo depends on `@xibosignage/xibo-layout-renderer` (XLR). In development, `electron.vite.config.js` aliases XLR to `../xibo-layout-renderer/src/index.ts`, so both repos must be cloned in the **same parent directory**. In production builds the alias is removed and the installed npm package is used.

Runtime config files are stored outside the repo:
- Windows: `%APPDATA%\xibo-player\` (`config.json`, `cms_config.json`)
- Linux: `$HOME/.config/xibo-player/`

## Architecture

### Process Separation

| Process | Entry Point | Responsibility |
|---------|-------------|----------------|
| **Main** | `src/main/index.ts` | XMDS communication, scheduling, file downloads, SQLite stats, IPC orchestration |
| **Renderer** | `src/renderer/src/renderer.ts` | Layout playback via XLR, configuration UI, fault/stats reporting |
| **Preload** | `src/preload/index.ts` | Sandboxed bridge exposing `window.apiHandler` and `window.playerAPI` |
| **Shared** | `src/shared/` | Types, logging, faults, schedule criteria (imported by both main and renderer) |

### Key Data Flows

**Startup:**
1. Main reads `config.json`; sends `configure` IPC to renderer if unconfigured
2. Renderer shows `ConfigHandler` UI; user enters CMS URL/key
3. Renderer calls `window.apiHandler.xmdsTryRegister()` → main attempts XMDS registration

**Schedule → Playback:**
1. Main's `scheduleManager` parses schedule XML and sends `update-loop` IPC with layout array
2. Renderer calls `xlr.updateLoop(layouts)`
3. XLR fetches layout XLF files from `http://localhost:9696/files/<layoutId>.xlf` (Express server at port 9696)
4. XLR parses XML and plays regions/widgets

**Proof-of-Play Stats:**
1. XLR emits `layoutStart`/`widgetStart` events
2. Renderer forwards to main via `BroadcastChannel('statsBC')`
3. Main writes to SQLite via `StatsDB`, batches and submits to CMS via `xmds.SubmitStats()`

**Logging:**
- Preload overrides `console.*` — all logs forwarded over IPC to main
- Main persists logs to SQLite via `ConsoleDB` in `src/shared/console/`
- Faults reported via `BroadcastChannel('player-faults-bc')` → main → XMDS

### IPC Events

- **Main → Renderer:** `configure`, `state-change`, `update-loop`, `update-overlays`, `showStatusWindow`
- **Renderer → Main:** `stats-bc-message`, `report-fault`, `open-child-window`, `renderer-log`

### XMDS (CMS Communication)

All CMS communication is SOAP-based via `src/main/xmds/xmds.ts`. The polling cycle: `RegisterDisplay` → `RequiredFiles` (download assets) → `GetSchedule` → `SubmitStats` / `SubmitLogs`.

### File Serving

Media assets are downloaded to `~/Documents/xibo_library/` and served at `http://localhost:9696/files/` via `src/main/express.ts`. The renderer process cannot access the filesystem directly — this HTTP bridge is required.

### Versioning

Single source of truth is `package.json` (`version` and `versionCode` fields). `electron.vite.config.js` injects these at build time as `__APP_VERSION__` and `__APP_VERSION_CODE__` compile-time constants. The `scripts/set-snap-version.cjs` script syncs the version to `snap/snapcraft.yaml` for Linux Snap builds.

### State Management

`src/main/common/state.ts` is the single source of player state. State changes are pushed to the renderer via `state-change` IPC events. There is no Redux/Zustand — state is managed imperatively in main and pushed down.

## TypeScript Configuration

- `tsconfig.json` — root, references `node` and `web` configs
- `tsconfig.node.json` — for main + preload + shared (Node.js target)
- `tsconfig.web.json` — for renderer + preload + shared (browser target)
