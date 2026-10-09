# Upgrading in-field devices from the legacy Xibo Windows player

This document covers moving existing devices running the legacy **Xibo Windows player**
(`xibosignage/xibo-dotnetclient`, WPF/.NET) onto this Electron player.

The player ships as a machine-wide MSI that carries the legacy player's product identity, so
installing it **upgrades the legacy install in place**: Windows removes the legacy player and
installs this one as a newer version of the same product. See "Delivery" below. Unlike the
[Linux migration](./UPGRADING-FROM-1.8.md), nothing reaches a device by itself; the MSI still has
to be deployed, by hand or by a deployment tool.

The rest of this document covers what happens once the new player starts on a device that still
has the legacy config on disk.

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

**The legacy config files are never modified.** Nothing is moved, rewritten or deleted. The MSI
upgrade does remove the legacy player's program files, so rolling back means uninstalling Xibo
Player and then reinstalling the legacy MSI, which finds its settings, library and hardware key as
it left them. Uninstall first: the two packages share an `UpgradeCode`, so the legacy MSI may
refuse to install over the newer version.

---

## Pre-flight checks before rolling out

1. **The real migration, against a real CMS.** Install the current published legacy MSI (e.g.
   `xibo-client-v4-R407.2-win32-x86.msi`) on a clean Windows VM, register it, confirm the display
   appears. Then install the new MSI over it, sign in as the same user, and confirm:
   - only one "Xibo Player" entry remains in Add/Remove Programs
   - **the same display** comes back online, not a new one
2. **Screensaver-mode devices.** If any fielded devices run the legacy player as `Xibo.scr`
   rather than the normal exe, confirm the `Xibo.xml` fallback picks up their settings.
3. **Autostart.** Reboot and confirm the player comes back, and that only one copy is running.
   Two mechanisms start it: the MSI places a shortcut in the all-users Start-up folder, so the
   player starts after a silent upgrade before it has ever run; and the player itself registers
   an HKCU `Run` entry on first launch via `app.setLoginItemSettings({ openAtLogin: true })`
   (`src/main/common/watchdog.ts`).
4. **Proxy, if any device in the fleet uses one.** Verify a proxied device reaches its CMS after
   migrating. The legacy player stores proxy domain and port as separate fields; this migration
   joins them into one URL the same way the Linux migration normalises its single `domain` field.
5. **A device with a placeholder or fallback hardware key**, if one exists in the fleet — confirm
   `legacy-config-incomplete` / an already-registered-under-the-fallback-value device both behave
   as expected (see the mapping notes above).
6. **Staged rollout.** Deploy the MSI to a small device group first.

---

## Delivery

The MSI is built from [installer/windows/](../installer/windows/README.md) and reuses the legacy
installer's `UpgradeCode`, product name and manufacturer. Windows Installer therefore treats it as
a newer version of the legacy product and performs a **major upgrade**: the legacy player is
removed and this one installed in a single transaction, under the same Add/Remove Programs entry.
A failure part way through rolls the whole upgrade back.

The legacy package owns nothing outside its program folder, the Start menu and the Start-up
folder. Removing it leaves its settings in `%APPDATA%`, its library and its `hardwarekey` file in
place, which is what the migration above reads on the player's first launch.

The MSI installs per machine and can be deployed silently, by hand or by Group Policy, SCCM,
Intune or any tool running as the computer:

```
msiexec /i xibo-player-4.0.13-x64.msi /qn
```

Two caveats:

- **The upgrade has not yet been tested against a fielded legacy install.** See "Not done yet" in
  the [installer README](../installer/windows/README.md). Run pre-flight check 1 before a wide
  rollout.
- **Per-user Squirrel installs are not removed.** Earlier releases of this player shipped a
  per-user `.exe` installer to `%LocalAppData%\xibo-player`. A device that received it keeps that
  install after the MSI goes on, so the player is installed twice. Uninstall it from Add/Remove
  Programs before or after deploying the MSI.

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
