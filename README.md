# Xibo Player Application for ElectronJS

This is a very early experiment, not to be used.

## Build and Run
```shell
npm run dev
```

## Structure

#### Main
The main process runs the configuration, xmds, scheduling and related business logic for the application to run. This also includes an express web server to locally serve files.

#### Renderer
The renderer process runs XLR (Xibo Layout Renderer).


## Config
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

## Packaging
You can build the packages for the following platforms.

### Windows
```shell
npm run package
```

### Linux

#### Debian package
```shell
npm run make
```

#### Snap package
```shell
npm run make:snap
```