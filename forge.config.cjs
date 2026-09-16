const MakerMsi = require('./installer/windows/MakerMsi.cjs');

module.exports = {
  packagerConfig: {
    ignore: [
      /^\/src/,
      /(.eslintrc.js)|(.gitignore)|(electron.vite.config.js)|(forge.config.cjs)|(tsconfig.*)/,
      /.vscode/,
      /.idea/,
      /.github/,
      "^/installer($|/)",
      "^/parts($|/)",
      "^/stage($|/)",
      "^/prime($|/)",
      "^/.snapcraft($|/)"
    ],
    icon: 'resources/icon',
  },
  rebuildConfig: {},
  makers: [
    // The machine-wide installer, and the only one that can replace the legacy
    // .NET player. See installer/windows/ and WINDOWS-PLAYER-PACKAGING.md.
    new MakerMsi({}, ['win32']),
    // Squirrel installs for a single user and cannot be deployed by Group Policy
    // or by any tool running as the computer. It stays the supported method until
    // the MSI ships, and is then removed. No further work belongs on it.
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          icon: 'resources/icon.png',
          maintainer: 'Xibo Signage Ltd',
          homepage: 'https://xibosignage.com',
        },
      },
    },
  ],
};
