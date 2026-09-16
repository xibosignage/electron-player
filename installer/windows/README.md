# Windows MSI packaging

The machine-wide installer for the Windows player. It exists so the player can be
deployed the way customers already deploy software — Group Policy, SCCM and Intune
running as the computer — and so it can replace the legacy .NET player in place
rather than sitting beside it in Add/Remove Programs.

Background and the decisions behind it are in `WINDOWS-PLAYER-PACKAGING.md`;
signing is in `WINDOWS-PLAYER-CODE-SIGNING.md`.

| File | Purpose |
|---|---|
| `xibo-player.wxs` | The installer itself: product identity, upgrade rule, files, shortcuts |
| `msi-config.cjs` | The product identity and version numbers, in one reviewable place |
| `MakerMsi.cjs` | Electron Forge maker that runs `wix build` over the packaged app |

## Building it

Needs the .NET SDK and the WiX toolset, which is a .NET global tool:

```
dotnet tool install --global wix --version "[6.0.0,7.0.0)"
```

Then, on Windows:

```
npm run make:msi
```

The result lands in `out/make/msi/x64/`. `npm run make` builds it alongside the
Squirrel `.exe`, which is still shipped until the MSI has been proven in the field.

## Three things worth knowing before changing anything here

**The UpgradeCode can never change.** `443E7578-7FEF-47E8-9078-04DDA8B96F3A` comes
from the legacy player's Advanced Installer project. It is the only reason Windows
treats this package as a newer version of that product. Changing it silently turns
every upgrade into a second installation.

**The MSI version is not the player version, and it is out of spec on purpose.**
See the comment in `msi-config.cjs`. If an upgrade over the legacy player does not
happen, this is the first thing to suspect.

**The Start-up shortcut is the package's job, not the player's.** The player writes
its own autostart entry, but only once it has launched. A silent upgrade with nobody
signed in removes the legacy player's Start-up shortcut and would otherwise leave
nothing to start the new one.

## Not done yet

- **Removing a per-user Squirrel install.** A screen that received the interim
  `.exe` installer keeps it after the MSI is installed, so the player would be
  installed twice. A machine-wide MSI runs as SYSTEM and cannot reach a user's
  `%LOCALAPPDATA%`, so this belongs in the player's own first-run migration rather
  than in a custom action here.
- **An icon.** `resources/` holds only `icon.png`; there is no `.ico`, so neither
  the executable nor the Add/Remove Programs entry carries the Xibo icon.
- **Installer UI.** Double-clicking the MSI installs it after the elevation prompt
  with no confirmation step. That suits silent deployment, which is the point of
  this package, but a `WixUI_Minimal` dialog set would be friendlier for manual
  installs.
- **The upgrade test.** Nothing here has been run against a fielded legacy install.
  Section 7 of `WINDOWS-PLAYER-PACKAGING.md` describes the test that proves the
  replacement, the version numbering and the display-identity migration together.
