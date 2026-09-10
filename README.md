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

**Linux** - `$HOME/.config/xibo-player/config.json` and `$HOME/.config/xibo-player/cms_config.json`

These configuration files are auto-generated on the first run. You can then edit/update the player config manually.


```json
// config.json
{
    "cmsUrl": "",
    "cmsKey": ""
}
```

---

### Screenshots on Linux (Wayland)

Wayland does not allow an application to capture the screen without the user approving a dialog, and that dialog cannot be suppressed. On an unattended sign there is nobody to accept it, so the player does not capture the screen on Wayland.

Instead it submits the newest image found in a `screenshots` folder, and you provide something to keep that folder up to date. X11 sessions capture directly and need no setup.

#### 1. Find the folder

The player creates it on startup, inside the media library:

**DEB** - `$HOME/Documents/xibo_library/screenshots`

**Snap** - `$HOME/snap/xibo-player/common/player-data/xibo_library/screenshots`

The exact path is written to the player log on startup. The Documents location follows your XDG user directories, so it can differ.

#### 2. Set up a task to write screenshots there

Any tool and any scheduler will do. The player only looks at the folder contents, never at how they got there. Most desktops provide their own screenshot tool, such as Spectacle on KDE Plasma or `grim` on Sway and Hyprland.

Replacing the same file each time is recommended, rather than adding a new one, so the folder does not grow indefinitely. Writing to a temporary file and moving it into place is also worth doing, as a move is atomic and the player can then never read a partially written file.

#### 3. How the player uses the folder

- The newest image by modification time is submitted. Filenames are not used, so name them however you like
- Files that are not images are ignored
- Nothing is ever deleted, so the last screenshot keeps being submitted until a newer one appears
- Screenshots are excluded from the Local Player API file server and cannot be downloaded over the network

When a screenshot is requested, if the folder is empty or the newest image has not been updated for some time, a fault is raised against the display in the CMS.

---

### Local Player API

The player runs a local HTTP server on port **9696** (configurable in Display Settings). Sources on the same device can reach it at `http://localhost:9696`. WAN connections can optionally be configured to allow access from other devices on the network; if not enabled, external requests are denied.

The API follows the endpoint contract defined in [xibo-interactive-control](https://github.com/xibosignage/xibo-interactive-control).

#### `GET /info`

Returns basic, non-sensitive player information.

**Response: `200 OK`**
```json
{
  "version": "4.0.0",
  "displayName": "Lobby Display",
  "hardwareKey": "xxxx",
  "screenWidth": 1920,
  "screenHeight": 1080,
  "longitude": 0,
  "latitude": 0,
  "timeZone": "",
  "currentLayoutId": 42,
  "displayStatus": 1
}
```

---

#### `POST /trigger`

Passes a trigger code to the layout renderer. Optionally targets a specific widget by ID; omit `id` to apply the trigger globally.

**Request body**
```json
{ "trigger": "my-trigger", "id": 123 }
```

| Field | Required | Description |
|-------|----------|-------------|
| `trigger` | Yes | Trigger code to pass to the layout renderer |
| `id` | No | Target widget ID. If omitted, the trigger applies globally |

**Responses**
- `200 OK` — `{ "success": true }`
- `400 Bad Request` — `{ "success": false, "error": "trigger is required" }`

---

#### `POST /duration/expire`

Expires the specified widget immediately, advancing the region to the next media item.

**Request body**
```json
{ "id": 1 }
```

**Response: `200 OK`** — `{ "success": true }`

---

#### `POST /duration/extend`

Adds seconds to the widget's remaining duration.

**Request body**
```json
{ "id": 1, "duration": 30 }
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Target widget ID |
| `duration` | Yes | Seconds to add to the remaining duration |

**Response: `200 OK`** — `{ "success": true }`

---

#### `POST /duration/set`

Sets the widget's duration to the given value in seconds.

**Request body**
```json
{ "id": 1, "duration": 60 }
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Target widget ID |
| `duration` | Yes | New duration in seconds |

**Response: `200 OK`** — `{ "success": true }`

---

#### `GET /realtime`

Returns data from the player's real-time data store for the given key.

**Query parameter**: `?dataKey=myKey`

**Responses**
- `200 OK` — JSON contents for the key, or empty body if no data exists for that key
- `400 Bad Request` — if `dataKey` is not provided

---

#### `POST /setCriteria`

Updates the schedule criteria used for dynamic layout selection. Sending the same metric again replaces the previous value. Expired entries are discarded and no longer affect schedule evaluation.

**Request body**
```json
{
  "criteriaUpdates": [
    { "metric": "people", "value": "5", "ttl": 300 },
    { "metric": "temperature", "value": "28 °C", "ttl": 300 },
    { "metric": "emergency_alert_category", "value": "Geo", "ttl": 60 }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `metric` | Yes | Name of the data point |
| `value` | Yes | Current value |
| `ttl` | No | Seconds before the value expires. Defaults to `300` |

**Responses**
- `200 OK` — `{ "success": true, "updated": 3 }`
- `400 Bad Request` — `{ "success": false, "error": "metric and value are required" }`

---

#### `POST /fault`

Raises a player fault. Only accessible from localhost.

If `key` contains `_`, the part after the underscore is parsed as the widget ID and the fault is raised with widget context. Otherwise the fault is raised without widget context.

**Request body**
```json
{
  "code": 5001,
  "key": "widget_123",
  "reason": "Widget failed to load",
  "ttl": 60
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | Fault code (integer) |
| `key` | Yes | Fault key. If it contains `_`, the part after the underscore is the widget ID |
| `reason` | Yes | Human-readable description |
| `ttl` | Yes | Seconds before the fault expires |

**Response: `200 OK`** — `{ "success": true }`
