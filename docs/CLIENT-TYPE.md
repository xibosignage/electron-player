# `clientType` / display-profile type

This documents what the `clientType` value sent in XMDS `RegisterDisplay` actually controls
on the CMS side, why the Electron player sends what it sends, and what was ruled out —
so the reasoning doesn't have to be re-derived next time this comes up.

## Background

`Config.getXmdsPlayerType()` (`src/main/config/config.ts`) supplies the `<clientType>` field
in the `RegisterDisplay` SOAP request (`src/main/xmds/xmds.ts`). Until now this was hardcoded
to the literal string `'linux'` for **both** the Windows and Linux Electron builds — accurate
for neither, since the intent (per a leftover comment) had been to eventually send
`'electron-win'` / `'electron-linux'`. That was never enabled because those types don't exist
in the CMS.

This was raised because seeing "Linux" against a Windows device in the CMS is confusing for
anyone administering the fleet.

## What `clientType` actually controls (xibo-cms, `develop` branch)

Researched by reading `xibosignage/xibo-cms` directly — not inferred from naming. It is **not**
cosmetic:

- `Soap5::RegisterDisplay` (`lib/Xmds/Soap5.php`) stores whatever string the player sends into
  `display.client_type` — a plain nullable `VARCHAR(20)`, no validation, no enum. Any string
  ≤20 chars is accepted silently.
- That value selects the **default Display Profile "type"** for any display without an
  explicit profile override (`Display::getDisplayProfile()` →
  `DisplayProfileFactory::getDefaultByType($clientType)`), which determines the settings
  schema and available Commands sent back in `RegisterDisplay`.
- CMS-recognized types today: `unknown, windows, android, linux, lg, sssp, chromeOS, hisense`
  (`DisplayProfileFactory::loadForType()`). **`electron-win`/`electron-linux` do not exist
  anywhere in the CMS repo.** Sending an unrecognized type doesn't error — it silently falls
  back to the `unknown` profile: empty settings schema, no commands.
- Commercial-licence exemption is hardcoded to a literal-string list (`Soap5.php`):
  `in_array($display->clientType, ['windows', 'linux'])` → `commercialLicence = 3` (not
  applicable). Anything outside that list makes the CMS start evaluating real
  commercial-licence logic against whatever the player's `RegisterDisplay` call reports.
- Websocket-vs-ZMQ XMR transport eligibility (`XmrClientTrait::isWebSocketXmrSupported()`) is
  also a literal-string + `clientCode` branch: `linux` needs `clientCode >= 400`, `windows`
  needs `clientCode >= 407`, `android` needs `>= 408`, `chromeOS` always qualifies. Our
  `versionCode` is `409`, so either branch is satisfied today.
- **The one that actually bites:** `Soap5.php` PascalCases every setting element name in the
  `RegisterDisplay` response (PHP `ucfirst()` — first letter only, e.g. `collectInterval` →
  `CollectInterval`) *specifically when* `clientType === 'windows'` — a compatibility shim for
  the legacy .NET client's XML deserializer. Our player's response parser
  (`RegisterDisplay.getSetting()` in `src/main/xmds/response/registerDisplay.ts`) did an
  exact-case property lookup expecting lowerCamelCase. Sending `'windows'` without fixing that
  would have made every CMS-pushed setting — collection interval, log level, stats enabled,
  aggregation level, XMR websocket address/key, adspace enablement, screen offset/size,
  geo-location-on-POP — silently fall back to its local default. No error, just quiet
  divergence from what the CMS thinks it configured.

## Options considered

| Option | Outcome |
|---|---|
| Keep `'linux'` for both platforms (status quo) | Functionally safest (dodges the PascalCase bug, keeps the licence exemption, lower XMR threshold), but every Windows device is mislabeled in the CMS. |
| Send `'windows'` on Windows builds, without other changes | Correct label, but silently breaks every CMS-pushed setting on Windows devices (the PascalCase issue above). Not viable as-is. |
| Send `'windows'` **and** fix the parser to tolerate both casings | Correct label, no CMS-side changes needed (`'windows'` already exists as a type), settings keep working. **Chosen.** |
| New CMS types `electron-win`/`electron-linux` | Cleanest long-term distinction — these would be genuinely ours rather than borrowed from either legacy client. Requires real CMS engineering: add both to `DisplayProfileFactory::loadForType()`, add them to the commercial-licence exemption list, add branches in `XmrClientTrait`. Can't be done from the player side alone; revisit if/when there's CMS-side appetite for it. |

## What changed

- `RegisterDisplay.resolveSettingKey()` (`src/main/xmds/response/registerDisplay.ts`) — looks
  up a setting by its lowerCamelCase name first, then falls back to the capitalized (`ucfirst`)
  variant, so `getSetting()` works regardless of which casing convention the CMS used for a
  given response.
- `Config.getXmdsPlayerType()` (`src/main/config/config.ts`) — now returns `'windows'` on
  `win32`, `'linux'` otherwise, instead of the `'linux'`-always hardcode.

## If this needs revisiting

The CMS-side facts above were read from `xibosignage/xibo-cms`'s `develop` branch and may have
moved on. Before relying on them again, re-check:
- `lib/Xmds/Soap5.php` — the `clientType`-gated PascalCasing and commercial-licence branches.
- `lib/Factory/DisplayProfileFactory.php::loadForType()` — the enumerated types and their
  settings schemas.
- `lib/Entity/XmrClientTrait.php::isWebSocketXmrSupported()` — the per-type `clientCode`
  thresholds.
