# TermiNox

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-D22128.svg)](./LICENSE)
![Version 2.0.0](https://img.shields.io/badge/version-2.0.0-111111.svg)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg)
![Vite 6](https://img.shields.io/badge/Vite-6-646CFF.svg)
![Rust Backend](https://img.shields.io/badge/backend-Rust-000000.svg)
![JavaScript Frontend](https://img.shields.io/badge/frontend-JavaScript-F7DF1E.svg)

TermiNox is an open-source desktop application for managing and monitoring VPS and server infrastructure from a single interface.

The app combines live infrastructure visibility, terminal access, file operations, session history, and fleet-wide controls into one desktop control surface.

## Stack

- **Tauri 2** — desktop runtime and native OS integration
- **Vite 6 + JavaScript** — frontend build and UI
- **Rust** — SSH, telnet, VNC proxying, SFTP, local shell, metrics, credential escrow
- **xterm.js** — embedded terminal sessions
- **Leaflet** — interactive node map

## Features

### Terminal
- SSH and Telnet session tabs with auto-reconnect (5 attempts, exponential backoff)
- Local shell tabs: PowerShell, CMD, WSL, Bash, Zsh
- **Split pane** — divide any terminal tab side-by-side into two independent sessions; drag divider to resize
- Tab rename (double-click label), pin tabs to persist across server switches
- Terminal search (Ctrl+F), right-click context menu (copy/paste/clear/select all)
- Bell notification: flashes tab label + OS desktop notification when app is unfocused
- Session logging to file

### Fleet Management
- Dashboard with online count, total nodes, and average latency
- Interactive world map with ping-aware node visualization and latency legend
- Sidebar with folder/group organization, search, and session shortcuts
- Metrics panel per node (CPU, memory, load, uptime)
- Recent session history

### SFTP
- Full SFTP browser with list and grid views
- Inline file editor with unsaved-changes tracking
- Upload, new file, chmod, symlink, drag-and-drop
- Path bookmarks — star any path, recall per server from the dropdown

### App Preferences
- **UI themes**: Night (deep navy), Dark (charcoal), Light — live preview, persisted
- **Terminal themes**: TermiNox, Dracula, Monokai, Solarized Dark, One Dark, Light — apply live to all open sessions
- Font size (slider), font family, cursor style and blink toggle
- Scrollback buffer size, bell enable/disable
- Import servers from `~/.ssh/config` — parses Host blocks, shows checkbox selection dialog

### Productivity
- **Command palette** (Ctrl+P) — fuzzy search all servers, keyboard navigate, Enter to connect
- **SSH config import** — Rust parser reads `~/.ssh/config`, resolves `~` paths, skips wildcards
- VNC tab support via noVNC WebSocket proxy

## Screenshots

Main dashboard:

![TermiNox dashboard screenshot](./img-prev/1.png)

Terminal and management view:

![TermiNox terminal and management screenshot](./img-prev/2.png)

## Project structure

```
src/                  Frontend (JS, CSS, HTML, assets)
  app.js              Main UI entry point (~7000 lines)
  styles.css          All styles and theme variables
src-tauri/            Tauri app and Rust backend
  src/
    main.rs           Backend entry + all Tauri commands
    ssh/              SSH session, SFTP, host key, probe, manager
    config/           Server config persistence (JSON store)
    ssh_config_parser.rs  ~/.ssh/config parser
    credential_escrow.rs  In-memory password escrow
    metrics_store.rs      Ring-buffer metrics history
```

## Getting started

### Prerequisites

- Node.js 18+ and npm
- Rust toolchain (`rustup`)
- Tauri prerequisites for your platform — see [Tauri docs](https://tauri.app/start/prerequisites/)

### Development

```bash
npm install
npm run dev
```

### Production build

```bash
npm run build
```

Output: `src-tauri/target/release/bundle/` — EXE, MSI installer, NSIS setup.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+P | Command palette |
| Ctrl+F | Terminal search |
| Ctrl+Shift+C | Copy terminal selection |
| Ctrl+V / Ctrl+Shift+V | Paste into terminal |
| Double-click tab label | Rename tab |

## License

Licensed under the Apache License 2.0. See [LICENSE](./LICENSE).

Redistributions and forks should preserve the attribution notice in [NOTICE](./NOTICE).
