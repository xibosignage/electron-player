# Upgrading in-field devices from the legacy Xibo Windows player

This document covers moving existing devices running the legacy **Xibo Windows player**
(`xibosignage/xibo-dotnetclient`, WPF/.NET) onto this Electron player.

Unlike the [Linux migration](./UPGRADING-FROM-1.8.md), there is no store-level trick (like a
snap refresh under a shared package name) that delivers this player to a device automatically.
**How the new installer actually reaches a device is a separate, unresolved decision** — see
"Delivery mechanism" below. This document only covers what happens once the new player starts on
a device that still has the legacy config sitting on disk, whichever way it got there.

The legacy player's on-disk config format has been stable across its releases — this migration
was verified against both its `master` branch (current, `4 R407.2` at time of writing) and its
old `release/tempel` branch (v1.8): same three files, same field names, same hardware-key
algorithm. So this isn't tied to a specific legacy version and shouldn't need revisiting as the
fielded version drifts.

---

## What gets migrated

On its first boot, the player looks for a legacy install and imports its **identity**. The
legacy hardware key lives in a plain-text `hardwarekey` file (an MD5 of CPU ID + volume serial +
MAC address) inside the legacy player's library folder, and this player would otherwise derive a
completely different key from `machineId()`. Without the import, **every migrated device
registers as a brand-new display** — losing its layouts, display group membership, settings
profile, statistics history, and consuming a fresh licence slot.

| Legacy field | Legacy location | Becomes |
|---|---|---|
| `hardwarekey` file contents | `<LibraryPath>\hardwarekey` | `config.json → hardwareKey` |
| `ServerUri` | `%APPDATA%\<exe-basename>.xml` | `config.json → cmsUrl` |
| `ServerKey` | `%APPDATA%\<exe-basename>.xml` | `config.json → cmsKey` |
| `ProxyDomain` + `ProxyPort` + `ProxyUser` + `ProxyPassword` | `%APPDATA%\<exe-basename>.xml` | `config.json → proxy` |
| `DisplayName` (from `<LibraryPath>\config.xml`) | `<LibraryPath>\config.xml` | `cms_config.json → displayName` |

### What does *not* get migrated

- **The media library.** Files are re-downloaded from the CMS on the first collection cycle.
  The legacy library path is recorded in `legacy-migration.json` (as `legacyLibrary`) so the disk
  can be reclaimed afterwards.
- **Unsubmitted proof-of-play stats.** Any records the legacy player had not yet submitted are
  lost. Devices that have been offline for a long time should be brought online and allowed to
  submit *before* migrating.
- **The XMR keypair** (`id_rsa`/`id_rsa.pub`). This player generates a new XMR channel and
  re-registers it with the CMS on the next `RegisterDisplay`.
- **CMS-driven settings** (collection interval, log level, screen size/position, adspace
  enablement, aggregation level, etc). These come back from the CMS display profile on the first
  collection, exactly as they do for a fresh install.

---

## Where the legacy config is read from

The legacy player is a per-user app; its config lives under the user profile it ran as, not a
system-wide location.

Checked in this order, first hit wins:

1. `$XIBO_LEGACY_WINDOWS_CONFIG_DIR` — override, for testing against a fixture directory.
2. `%APPDATA%` (`Environment.SpecialFolder.ApplicationData` in .NET terms) — where the real
   legacy player always writes its global settings file.

Within that directory, two basenames are tried in order: `XiboClient.xml` (the normal running
module), then `Xibo.xml` (used when the legacy player runs as the `Xibo.scr` screensaver — the
settings basename tracks whichever module was actually running).

From there:

- `LibraryPath` is read out of that global settings file. If it's missing or the literal
  sentinel `DEFAULT` (the shipped default), it's resolved the same way the legacy app resolves it
  at runtime: `<Documents>\Xibo Library`.
- `<LibraryPath>\hardwarekey` — read verbatim, including the legacy fallback literal
  (`Change for Unique Key`) if that device's CPU/volume lookup ever failed, since the CMS may
  already know the device by that exact value.
- `<LibraryPath>\config.xml` supplies `DisplayName` (resolving the `COMPUTERNAME` sentinel to the
  device's actual hostname, matching the legacy player's own fallback).

A `ServerKey` equal to the shipped placeholder (`yourserverkey`) is treated as unset — that
means the device was never really configured beyond the shipped defaults, so there is no real
identity to preserve.

**The legacy files are never modified.** Nothing is moved, rewritten or deleted, so the legacy
install is left intact if you need to roll back.

---

## Pre-flight checks before rolling out

1. **The real migration, against a real CMS.** Install the current published legacy MSI (e.g.
   `xibo-client-v4-R407.2-win32-x86.msi`) on a clean Windows VM, register it, confirm the display
   appears. Then run the new Electron player against the same user profile and confirm **the
   same display** comes back online — not a new one.
2. **Screensaver-mode devices.** If any fielded devices run the legacy player as `Xibo.scr`
   rather than the normal exe, confirm the `Xibo.xml` fallback picks up their settings.
3. **Autostart.** Reboot and confirm the player comes back — this player uses
   `app.setLoginItemSettings({ openAtLogin: true })` (`src/main/common/watchdog.ts`), Electron's
   wrapper around the Windows `Run` registry key.
4. **Proxy, if any device in the fleet uses one.** Verify a proxied device reaches its CMS after
   migrating. The legacy player stores proxy domain and port as separate fields; this migration
   joins them into one URL the same way the Linux migration normalises its single `domain` field.
5. **A device with a placeholder or fallback hardware key**, if one exists in the fleet — confirm
   `legacy-config-incomplete` / an already-registered-under-the-fallback-value device both behave
   as expected (see the mapping notes above).
6. **Staged rollout.** However delivery ends up working (see below), roll it out to a small
   device group first.

---

## Delivery mechanism — open, not solved here

The Linux migration works for free because the snap store publishes both players under the
identical package name — an in-place snap refresh *is* the delivery mechanism. There is no
Windows equivalent today: this player's `forge.config.cjs` uses `@electron-forge/maker-squirrel`
with no custom identity, so it installs as a brand-new Squirrel app (`xibo-player`) under
`%LocalAppData%\xibo-player` — a completely separate product, install path, and Add/Remove
Programs entry from the legacy WPF app (which ships its own MSI).

Publishing this Electron build will **not** silently replace the legacy install. Achieving a
silent, same-identity swap needs one of:

- **MSI major upgrade** — package the new player as an MSI that reuses the legacy installer's
  `UpgradeCode`, so `msiexec` performs a true in-place upgrade and keeps the same Add/Remove
  Programs entry. Requires the legacy installer/WiX project (not in the open-source
  `xibo-dotnetclient` repo — likely a separate internal deployment pipeline).
- **Externally orchestrated replace** — RMM/GPO/SCCM silently uninstalls the legacy MSI and
  installs the new Squirrel setup as two steps. The migration code in this repo doesn't care how
  it got there, only that it runs before `config.load()` on first launch.

This needs resolving with whoever owns Windows fleet deployment before a wide rollout — it
determines whether the migration path in this document ever actually runs in the field.

---

## Verifying a device migrated correctly

1. In the CMS, the display should come back online under **the same display**, with its layouts
   and group membership intact. No new display should appear.
2. On the device, read the migration record (written to the same directory as `config.json`):

   ```
   type C:\Users\<user>\AppData\Roaming\xibo-player\legacy-migration.json
   ```

   ```json
   {
     "migrated": true,
     "sourceDir": "C:\\Users\\<user>\\AppData\\Roaming",
     "hardwareKey": "…",
     "cmsUrl": "https://cms.example.com",
     "legacyLibrary": "C:\\Users\\<user>\\Documents\\Xibo Library",
     "proxyMigrated": false,
     "migratedAt": "…"
   }
   ```

3. Confirm `config.json → hardwareKey` matches the legacy player's `<LibraryPath>\hardwarekey`
   file contents.

This file is also the idempotency guard — once it exists, migration never runs again.

### If `migrated` is `false`

| `reason` | Meaning | Action |
|---|---|---|
| `no-legacy-install-found` | No `XiboClient.xml`/`Xibo.xml` in `%APPDATA%`. | Expected on new installs. If the device *did* run the legacy player, locate its config and re-run with `XIBO_LEGACY_WINDOWS_CONFIG_DIR` set. |
| `legacy-config-incomplete` | `hardwarekey`, `ServerUri`, or a non-placeholder `ServerKey` was missing. | Recover the identity by hand: read the device's existing hardware key from its display in the CMS, write it into `config.json` as `hardwareKey` along with `cmsUrl`/`cmsKey`, delete `legacy-migration.json`, and restart. |
| `player-already-configured` | A `config.json` already existed. | Not a migration scenario. |
| `already-attempted` | Migration ran previously. | Delete `legacy-migration.json` to allow a retry. |
| `error` | Parse or I/O failure. | No marker is written in this case, so the player retries automatically on the next boot. Check the log for the parse error; the legacy files are untouched. |

To retry a migration on a device, delete both `config.json` and `legacy-migration.json` from the
player's config directory and restart.
