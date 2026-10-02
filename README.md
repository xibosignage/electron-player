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
