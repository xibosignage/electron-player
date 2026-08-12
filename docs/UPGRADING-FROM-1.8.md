# Upgrading in-field devices from the Xibo Linux 1.8 player

This document covers moving existing devices running the legacy **Xibo Linux 1.8 player**
(`xibosignage/xibo-linux`, C++/GTK) onto this Electron player.

Both players publish to the snap store under the same name, **`xibo-player`**, so the upgrade
is an ordinary **in-place snap refresh**. Devices pick it up automatically; no operator action
is needed on each device.

---

## What gets migrated

On its first boot after the refresh, the player looks for a legacy install and imports its
**identity**. This is the part that matters: the legacy hardware key is
`cmsSettings.xml → displayId` (an MD5 of cpuid + MAC address), and this player would otherwise
derive a completely different key from `machineId()`. Without the import, **every refreshed
device registers as a brand-new display** — losing its layouts, display group membership,
settings profile, statistics history, and consuming a fresh licence slot.

| Legacy field (`cmsSettings.xml`) | Becomes |
|---|---|
| `displayId` | `config.json → hardwareKey` |
| `cmsAddress` | `config.json → cmsUrl` |
| `key` | `config.json → cmsKey` |
| `domain` / `username` / `password` | `config.json → proxy` |
| `displayName` (from `playerSettings.xml`) | `cms_config.json → displayName` |

### What does *not* get migrated

- **The media library.** Files are re-downloaded from the CMS on the first collection cycle.
  On a large library over a metered or slow link this is a real cost — plan the rollout
  accordingly. The legacy library path is recorded in `legacy-migration.json` so the disk can
  be reclaimed afterwards.
- **Unsubmitted proof-of-play stats** in the legacy `stats.sqlite`. Any records the legacy
  player had not yet submitted are lost. Devices that have been offline for a long time should
  be brought online and allowed to submit *before* the refresh reaches them.
- **The XMR keypair** (`id_rsa`/`id_rsa.pub`). This player generates a new XMR channel and
  re-registers it with the CMS on the next `RegisterDisplay`.
- All other player settings (collection interval, log level, screen size/position). These come
  back from the CMS display profile on the first collection.

---

## Where the legacy config is read from

Checked in this order, first hit wins:

1. `$XIBO_LEGACY_CONFIG_DIR` — override, for deb/tarball installs (where the legacy player
   keeps its config next to its binary) and for testing.
2. `$SNAP_USER_COMMON` — `~/snap/xibo-player/common/`. Where R6+ devices keep it.
3. `$SNAP_USER_DATA` — `~/snap/xibo-player/<revision>/`. Older devices that never ran a build
   with the config-relocating watchdog.

The current `<settings version="2">` format is handled and verified.

> **Caveat on the version 1 format.** Pre-R6 devices wrote a settings file with no `<settings>`
> root element (the legacy `XmlFileLoaderMissingRoot` path). The exact shape of those files is
> not recoverable from the legacy source alone, so the parser infers it: it falls back to the
> document's root element and reads the fields from there. This is covered by tests against a
> reconstructed file, **not against a genuine pre-R6 device.** If a real v1 file differs, the
> migration reports `legacy-config-incomplete` and skips rather than importing something wrong
> — it fails safe. Test against a real pre-R6 device before including those devices in a
> rollout.

**The legacy directory is never modified.** Nothing is moved, rewritten or deleted, which is
what makes rollback work.

---

## Pre-flight checks before publishing to `stable`

Do these on a clean VM with the published legacy snap installed. Skipping them risks breaking
the whole fleet at once.

1. **`grade: stable` in [snap/snapcraft.yaml](../snap/snapcraft.yaml).** The store rejects a
   `devel`-grade snap on the stable channel, so a `devel` build never reaches the fleet at
   all. Confirm before every release — this is easy to flip back during development.
2. **The real refresh, against a real CMS.** Install the *published* legacy snap, register it,
   confirm the display appears. Then swap in the new revision and confirm **the same display**
   comes back online and no new display is created. This is the check that matters; everything
   else is secondary.
3. **Plug connections.** Run `snap connections xibo-player` before and after the refresh.
   Confirm every plug the new revision declares is actually connected. `browser-support` has
   been deliberately dropped (the Chromium sandbox is already disabled via `--no-sandbox`)
   because it is not auto-connected and an unconnected plug is a silent failure.
4. **Resolved data paths.** Log `app.getPath('userData')`, `app.getPath('documents')` and
   `config.library` from the snap-installed build and check them against the table below.
   `app.getPath('documents')` under confinement is the uncertain one — the library must not
   land under the versioned `SNAP_USER_DATA`, or every refresh duplicates it.
5. **Autostart.** Reboot and confirm the player comes back. If snapd's user session agent does
   not pick up the entry on your target distro, fall back to a systemd user service.
6. **Proxy, if any device in the fleet uses one.** Verify a proxied device reaches its CMS
   after the refresh. See the proxy section below for the known limitation.
7. **A genuine pre-R6 device**, if any remain in the fleet — the only way to validate the v1
   settings format. See the caveat above.
8. **Staged rollout.** Publish to a progressive-release channel or a small device group first.
   A refresh reaches every device on the channel at once.

---

## Where things live after the upgrade

Inside a snap, `HOME` is remapped to `SNAP_USER_DATA` (`~/snap/xibo-player/current/`), so the
player's own config lands under that. Bulk data is deliberately kept in `SNAP_USER_COMMON`,
which is shared across revisions rather than copied forward on every refresh.

| Path | Contents |
|---|---|
| `~/snap/xibo-player/current/.config/xibo-player/config.json` | Identity: hardware key, CMS URL/key, proxy |
| `~/snap/xibo-player/current/.config/xibo-player/cms_config.json` | Display name and CMS-supplied settings |
| `~/snap/xibo-player/current/.config/xibo-player/legacy-migration.json` | Migration record and idempotency guard |
| `~/snap/xibo-player/current/.config/autostart/xibo-player.desktop` | Autostart entry |
| `~/snap/xibo-player/common/player-data/xibo_library/` | Downloaded media |
| `~/snap/xibo-player/common/player-data/playerDb.db` | File store |
| `~/snap/xibo-player/common/player-data/stats/stats.db` | Proof-of-play stats |
| `~/snap/xibo-player/common/player-data/watchdog-restarts.json` | Recent crash-restart timestamps |
| `~/snap/xibo-player/common/cmsSettings.xml`, `playerSettings.xml`, `id_rsa*` | **Legacy player files. Read-only to this player; left in place for rollback.** |

---

## Proxy support

The legacy player supported an upstream HTTP proxy; a migrated device behind one cannot reach
its CMS without equivalent support here, so the proxy is imported and applied on every boot
([src/main/common/proxy.ts](../src/main/common/proxy.ts)).

The legacy `domain` field is a bare host (optionally with a port); it is normalised to an
absolute URL, defaulting to `http://` when no scheme is present. Two stacks are configured
separately:

- **Chromium** (the renderer and anything a layout fetches) via `session.setProxy()`, with
  credentials supplied through the `login` event rather than the URL.
- **Node** — XMDS/SOAP and every file download go through axios in the main process, which
  does *not* honour the Chromium session proxy. These use the standard
  `HTTP_PROXY`/`HTTPS_PROXY` environment variables instead.

`localhost`, `127.0.0.1` and `::1` are always bypassed, so the embedded media server on port
9696 is never proxied.

**Known limitation:** the Node side relies on axios's built-in environment-variable proxy
handling. If an authenticating proxy in front of an HTTPS CMS gives trouble, that is the first
thing to investigate — it may need an explicit proxy agent.

---

## Restart-on-crash and autostart

The legacy snap ran the player under a separate watchdog process
(`xibo-linux/player/watchdog/ProcessWatcher.cpp`) that restarted it whenever it exited. That
binary is gone after the refresh, so the behaviour is reimplemented in-process
([src/main/common/watchdog.ts](../src/main/common/watchdog.ts)).

- A renderer crash or an unresponsive renderer relaunches the whole player process. A full
  relaunch is used rather than a renderer reload because the main process would otherwise be
  left holding stale playback state.
- Restarts are capped at **5 within 10 minutes**. On hitting the cap the player deliberately
  stops restarting and stays up so the fault can be diagnosed — a device sitting on a blank or
  broken screen rather than restart-looping is usually this. Check
  `player-data/watchdog-restarts.json` and the player log, then clear that file to re-arm.
- An autostart entry is written on first run so the player returns after a reboot, replacing
  the autostart the legacy snap got from its desktop entry.

---

## Verifying a device migrated correctly

1. In the CMS, the display should come back online under **the same display ID**, with its
   layouts and group membership intact. No new display should appear.
2. On the device, read the migration record:

   ```bash
   cat ~/snap/xibo-player/current/.config/xibo-player/legacy-migration.json
   ```

   ```json
   {
     "migrated": true,
     "sourceDir": "/home/xibo/snap/xibo-player/common",
     "hardwareKey": "…",
     "cmsUrl": "https://cms.example.com",
     "legacyLibrary": "/home/xibo/snap/xibo-player/common/resources",
     "proxyMigrated": false,
     "migratedAt": "…"
   }
   ```

3. Confirm `config.json → hardwareKey` matches `displayId` in the legacy
   `cmsSettings.xml`.

This file is also the idempotency guard — once it exists, migration never runs again.

### If `migrated` is `false`

| `reason` | Meaning | Action |
|---|---|---|
| `no-legacy-install-found` | No `cmsSettings.xml` in any candidate directory. | Expected on new installs. If the device *did* run 1.8, locate its config and re-run with `XIBO_LEGACY_CONFIG_DIR` set. |
| `legacy-config-incomplete` | `displayId`, `cmsAddress` or `key` was missing/empty — or a v1 file did not parse as expected (see the caveat above). | Recover the identity by hand: read the device's existing hardware key from its display in the CMS, write it into `config.json` as `hardwareKey` along with `cmsUrl`/`cmsKey`, delete `legacy-migration.json`, and restart. The device then reconnects to its existing display rather than creating a new one. |
| `player-already-configured` | A `config.json` already existed. | Not a migration scenario. |
| `already-attempted` | Migration ran previously. | Delete `legacy-migration.json` to allow a retry. |
| `error` | Parse or I/O failure (e.g. a truncated `cmsSettings.xml`). | No marker is written in this case, so the player retries automatically on the next boot. Check the log for the parse error; the legacy files are untouched. |

To retry a migration on a device, delete both `config.json` and `legacy-migration.json` from
the player's config directory and restart.

---

## Rollback

```bash
snap revert xibo-player
```

This restores the previous revision, and with it `SNAP_USER_DATA`. Because the migration only
ever *reads* from the legacy config directory, the legacy player finds its `cmsSettings.xml`,
`playerSettings.xml` and keys exactly as it left them and resumes against the same display.

Its media library is also untouched — the new player downloads into a separate directory
(`$SNAP_USER_COMMON/player-data/xibo_library`) rather than reusing the legacy `localLibrary`.

Two things a revert does **not** undo, neither of them harmful:

- **`$SNAP_USER_COMMON/player-data/` is left behind.** `SNAP_USER_COMMON` is shared across
  revisions, so it does not roll back. The legacy player ignores it. Delete the directory to
  reclaim the disk if the rollback is permanent.
- **The display's XMR channel has been re-registered** by the new player. The legacy player
  re-registers its own on its next `RegisterDisplay`, so this resolves itself on the next
  collection.

Because the revert restores `SNAP_USER_DATA`, the new player's `config.json` and
`legacy-migration.json` go away with it — so a later re-upgrade migrates cleanly from scratch.
