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
| `licenseRtf.cjs` | Converts the repository `LICENSE` into the RTF the licence page needs |

## Building it

Needs the .NET SDK, the WiX toolset (a .NET global tool) and the WiX UI
extension, which supplies the installer dialogs:

```
dotnet tool install --global wix --version 6.0.0
wix extension add -g WixToolset.UI.wixext/6.0.0
```

Both versions must match. Asking for the extension without one resolves to the
newest release, which is a later major and is rejected at build time. If the
extension is missing the maker says so before WiX gets a chance to fail opaquely.

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

## The dialogs

The package exists to be deployed silently, where no dialog is ever shown. The UI is
for the other case: somebody running the MSI by hand on a screen. It uses WiX's
`WixUI_InstallDir` set — welcome, licence, install folder, confirm, progress, finish
— chosen over the shorter `WixUI_Minimal` because it lets an administrator retarget
the install folder, which matters on signage machines with a small system drive.

The licence page shows the repository's own `LICENSE`, converted to RTF during the
build rather than committed as a second copy, so the two cannot drift apart.

`WixUI_InstallDir` sets `ARPNOMODIFY` itself. That is why `xibo-player.wxs` sets only
`ARPNOREPAIR`: defining either twice is a build error, not a warning.

The dialogs are unbranded. WiX's default banner and background bitmaps are generic;
replacing them needs a 493x58 and a 493x312 image and the `WixUIBannerBmp` and
`WixUIDialogBmp` variables.

## Not done yet

- **Removing a per-user Squirrel install.** A screen that received the interim
  `.exe` installer keeps it after the MSI is installed, so the player would be
  installed twice. A machine-wide MSI runs as SYSTEM and cannot reach a user's
  `%LOCALAPPDATA%`, so this belongs in the player's own first-run migration rather
  than in a custom action here.
- **Branded installer dialogs.** See above; the layout is WiX's stock one.
- **The upgrade test.** Nothing here has been run against a fielded legacy install.
  Section 7 of `WINDOWS-PLAYER-PACKAGING.md` describes the test that proves the
  replacement, the version numbering and the display-identity migration together.
