# Xibo Player Application for ElectronJS

This is a very early experiment, not to be used.

## Build and Run
```shell
npm run dev
```

## Structure
Main runs configuration, xmds, scheduling, etc.
Main runs an express webserver for locally serving files. 
Renderer runs XLR.


## Config
Configuration via `%APPDATA%/config.json` which is auto created after the first run. You can then edit it manually and add

```json
{
    "cmsUrl": "",
    "cmsKey": ""
}
```