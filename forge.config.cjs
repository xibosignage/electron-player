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

/**
 * The prebuilt binary families better-sqlite3 ships. It carries one for every
 * platform it supports, not just the one being built for.
 */
const PREBUILD_FAMILIES = ['darwin', 'linux', 'linuxmusl', 'win32'];

/**
 * An ignore pattern dropping every better-sqlite3 prebuilt binary that cannot run
 * on the platform being built for.
 *
 * Worth keeping even though they are only a few megabytes each. Signing sweeps the
 * package for .node files, and SignTool fails the whole build on a Mach-O or ELF
 * file rather than skipping it, so a Windows release cannot be signed while they
 * are present. Enabling asar would not help: native modules are unpacked to
 * app.asar.unpacked and are still on disk to be found.
 *
 * @return {RegExp} Matched against paths relative to the project root.
 */
function foreignPrebuilds() {
  const target = targetPlatform();

  // A glibc Linux build and a musl one are both 'linux' to Node, and the player
  // ships as both a .deb and a snap, so neither can be dropped.
  const keep = target === 'linux' ? ['linux', 'linuxmusl'] : [target];
  const drop = PREBUILD_FAMILIES.filter((family) => !keep.includes(family));

  return new RegExp(
    `^/node_modules/better-sqlite3/prebuilds/(${drop.join('|')})-`);
}

module.exports = {
  packagerConfig: {
    ignore: [
      /^\/src/,
      /(.eslintrc.js)|(.gitignore)|(electron.vite.config.js)|(forge.config.cjs)|(tsconfig.*)/,
      /.vscode/,
      /.idea/,
      /.github/,
      '^/installer($|/)',
      '^/parts($|/)',
      '^/stage($|/)',
      '^/prime($|/)',
      '^/.snapcraft($|/)',
      foreignPrebuilds(),
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
