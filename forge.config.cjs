const MakerMsi = require('./installer/windows/MakerMsi.cjs');

/**
 * Application icons, by the platform being built for.
 *
 * @electron/packager takes a single path with the extension left off and appends
 * the platform's own, and rejects an array on Windows, so it cannot be given a
 * whole set at once.
 *
 * Only Windows is listed. Linux is absent because packager does not use an icon
 * there at all — a Linux app's icon comes from the .desktop file, which maker-deb
 * writes from its own icon option below. macOS is absent because resources/ has
 * no .icns; the darwin zip is a by-product, not a shipped player.
 *
 * The path is extension-less on purpose. Do not add one.
 */
const ICON_PATHS = {
  win32: 'resources/windows/icon',
};

/**
 * The platform Forge is building for: its --platform argument when given, and
 * otherwise the machine running the build, which is what Forge itself defaults to.
 *
 * @return {string} A Node platform name.
 */
function targetPlatform() {
  const flag = process.argv.indexOf('--platform');
  return flag !== -1 && process.argv[flag + 1] ?
    process.argv[flag + 1] :
    process.platform;
}

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
    icon: ICON_PATHS[targetPlatform()],
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
          icon: 'resources/linux/icons/512x512.png',
          maintainer: 'Xibo Signage Ltd',
          homepage: 'https://xibosignage.com',
        },
      },
    },
  ],
};
