module.exports = {
  packagerConfig: {
    ignore: [
      /^\/src/,
      /(.eslintrc.js)|(.gitignore)|(electron.vite.config.js)|(forge.config.cjs)|(tsconfig.*)/,
      /.vscode/,
      /.idea/,
      /.github/
    ],
    icon: '/resources/icon',
  },
  rebuildConfig: {},
  makers: [
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
          icon: '/resources/icon.png',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          icon: '/resources/icon.png',
        },
      },
    },
  ],
};
