# Xibo Player Application for ElectronJS

A cross-platform desktop digital signage player builth with Electron and Vite, designed for running Xibo layouts using the **Xibo Layout Renderer (XLR)**.

The application cleanly separates business logic and layout rendering, and supports package for **Windows** and **Linux** (DEB and Snap).

### Features
- **Main-process-driven architecture**
    - Centralized business logic
    - Configuration management
    - XMDS communication
    - Scheduling and playback orchestration
- **Renderer powered by XLR**
    - Uses the shared **Xibo Layout Renderer (XLR)** library
    - Focused purely on layout rendering and playback
    - No business logic leakage into the renderer
- **Modern tooling**
    - Electron + Vite for fast development and optimized builds
    - TypeScript-first codebase
- **Cross-platform packaging**
    - Windows installer
    - Linux
        - `.deb`
        - `.snap`

---

### Architecture Overview
The application follows Electron best practices by clearly separating responsibilities between the main and renderer process.

#### Main Process
The **main process** acts as the brain of the application and is responsible for all business-critical functionality, including but not limited to:

- Application configuration
- XMDS communication
- Device registration and authorization
- Schedule fetching and evaluation
- Inter-process communication (IPC)
- Native OS integrations
- Packaging and platform-specific behavior

> No rendering or layout logic lives in the main process.

#### Renderer Process
The **renderer process** is intentionally lightweight and focused exclusively on rendering.

Responsibilities:

- Rendering Xibo layouts using **Xibo Layout Renderer (XLR)**
- Media playback (video, image, HTML, etc)
- Responding to playback commands from the main process via IPC

> The renderer does not handle configuration, scheduling, or XMDS logic.

---

### Development

#### Prerequisites
- Node.js (LTS recommended)
- npm
- Linux or WIndows development environment

#### Install Dependencies

```shell
npm install
```

#### Run in Development Mode
```shell
npm run dev
```

This starts:

- Electron main process
- Vite dev server for the renderer

---

### Building and Packaging

#### Build Application

```shell
npm run build
```

#### Package for Windows

```shell
npm run package
```

Generates:

- Windows installer / executable

#### Package for Linux

##### DEB Package

```shell
npm run make
```

##### Snap Package

```shell
npm run make:snap
```

---

### Configuration
There are two configuration files created used for Player and CMS.

For the player it will be in,

**Windows** - `%APPDATA%/config.json` and `%APPDATA%/cms_config.json`

**Linux** - `$HOME/.config/xibo-electron/config.json` and `$HOME/.config/xibo-electron/cms_config.json`

These configuration files are auto-generated on the first run. You can then edit/update the player config manually.


```json
// config.json
{
    "cmsUrl": "",
    "cmsKey": ""
}
```
