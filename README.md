# Xibo Player Application for ElectronJS

A cross-platform desktop digital signage player built with Electron and Vite, designed for running Xibo layouts using the **Xibo Layout Renderer (XLR)**.

The application cleanly separates business logic and layout rendering, and is packaged for **Windows** (MSI) and **Linux** (DEB and Snap).

### Documentation

- [DEVELOPER.md](DEVELOPER.md) - development setup, architecture and common tasks
- [installer/windows/README.md](installer/windows/README.md) - building the Windows MSI
- [docs/UPGRADING-FROM-1.8.md](docs/UPGRADING-FROM-1.8.md) - migrating devices from the legacy Xibo Linux 1.8 player
- [docs/UPGRADING-FROM-WINDOWS.md](docs/UPGRADING-FROM-WINDOWS.md) - migrating devices from the legacy Xibo Windows player

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
- Node.js 22 or newer
- npm
- Linux or Windows development environment

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

Installers are built on the platform they target: the MSI on Windows, the DEB and Snap on Linux.

| Command | Output |
|---|---|
| `npm run build` | Compiled bundles in `dist/` |
| `npm run package` | Unpacked app in `out/xibo-player-<platform>-x64/`, no installer |
| `npm run make` | Installers for the current platform: the MSI on Windows, the DEB on Linux |
| `npm run make:msi` | Windows MSI only, in `out/make/msi/x64/` |
| `npm run make:snap` | Snap package, in `out/make/snap/x64/` |

#### Windows (MSI)

```shell
npm run make:msi
```

Needs the .NET SDK and the WiX 6 toolset with its UI extension. See [installer/windows/README.md](installer/windows/README.md) for setup and for what must not change in the installer. Local builds are unsigned; release builds are signed by the release workflow.

#### Linux (DEB)

```shell
npm run make
```

The `.deb` is written to `out/make/deb/x64/`.

#### Linux (Snap)

```shell
npm run make
npm run make:snap
```

`make:snap` packs the app that `make` (or `package`) leaves in `out/xibo-player-linux-x64/`, so run that first. It needs `snapcraft`, and copies the version from `package.json` into `snap/snapcraft.yaml` before packing.

---

### Configuration
The player keeps two configuration files, both created on first run:

- `config.json` - the player's identity and connection: hardware key, CMS address and key, proxy
- `cms_config.json` - display name and the settings pushed by the CMS. It is overwritten on every collection, so do not edit it by hand

| Install | Location |
|---|---|
| Windows | `%APPDATA%\xibo-player\` |
| Linux (DEB) | `$HOME/.config/xibo-player/` |
| Linux (Snap) | `$HOME/snap/xibo-player/current/.config/xibo-player/` |

The CMS address and key are normally entered on the Configuration page. They can also be set in `config.json` while the player is stopped. Leave the other fields as they are: `hardwareKey` is how the CMS recognises this display, and changing it registers the player as a new display.

```json
{
  "hardwareKey": "…",
  "xmrChannel": "…",
  "cmsUrl": "https://cms.example.com",
  "cmsKey": "yourserverkey",
  "macAddress": "…",
  "platform": "linux",
  "pendingCmsTransfer": null,
  "proxy": null
}
```

To route traffic through an HTTP proxy, set `proxy` to `{ "url": "http://proxy.example.com:8080", "username": "", "password": "" }`. The username and password are optional.

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

The player runs a local HTTP server on port **9696**. The port is fixed and cannot be changed from Display Settings. Sources on the same device reach it at `http://localhost:9696`.

The server listens on all network interfaces and allows cross-origin requests, so other devices on the network can reach every endpoint except `/fault`, which only accepts requests from the device itself. Use a firewall to block port 9696 if the player should not be reachable from the network.

The API follows the endpoint contract defined in [xibo-interactive-control](https://github.com/xibosignage/xibo-interactive-control).

#### `GET /files` and `GET /files/<name>`

Serves the media library to the layout renderer. `/files` returns a JSON listing of the library, and `/files/<name>` returns a single file. The `screenshots` folder is excluded from both.

---

#### `GET /info`

Returns basic, non-sensitive player information.

**Response: `200 OK`**
```json
{
  "version": "4.0.12",
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

Passes a trigger code to the current layout's actions and to any schedule-level Action event with the same trigger code. Optionally targets a specific widget by ID; omit `id` to apply the trigger globally.

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

**Responses**
- `200 OK` — `{ "success": true }`
- `400 Bad Request` — `{ "success": false, "error": "id is required" }`

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

**Responses**
- `200 OK` — `{ "success": true }`
- `400 Bad Request` — `{ "success": false, "error": "id is required and duration must be a valid number" }`

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

**Responses**
- `200 OK` — `{ "success": true }`
- `400 Bad Request` — `{ "success": false, "error": "id is required and duration must be a valid number" }`

---

#### `GET /realtime`

Returns data that a data connector has published to the player's real-time data store for the given key.

**Query parameter**: `?dataKey=myKey`

**Responses**
- `200 OK` — JSON contents for the key
- `400 Bad Request` — `{ "success": false, "error": "dataKey is required" }`
- `404 Not Found` — `{ "success": false, "error": "No data for dataKey" }`, when nothing has been published for the key

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
- `400 Bad Request` — `{ "success": false, "error": "criteriaUpdates must be an array" }`
- `400 Bad Request` — `{ "success": false, "error": "metric and value are required" }`. Entries before the invalid one have already been applied

---

#### `POST /fault`

Raises a player fault, which is reported to the CMS. Only accessible from the device itself.

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

**Responses**
- `200 OK` — `{ "success": true }`
- `400 Bad Request` — `{ "success": false, "error": "code, key, reason and ttl are required" }`
- `403 Forbidden` — `{ "success": false, "error": "Forbidden" }`, when the request comes from another device
