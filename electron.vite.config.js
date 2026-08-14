/*
 * Copyright (c) 2024 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */
import {resolve} from 'path';
import {readFileSync} from 'node:fs';
import {defineConfig} from 'electron-vite';

export default defineConfig(({mode}) => {
  const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));
  const versionDefine = {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_VERSION_CODE__: packageJson.versionCode || 0,
  };

  let devLibraries = [];
  let alias = {};

  if (mode !== 'production') {
    devLibraries = [
      '@xibosignage/xibo-layout-renderer',
      '@xibosignage/xibo-communication-framework',
    ];
    alias = {
      '@xibosignage/xibo-layout-renderer': resolve(__dirname, '../xibo-layout-renderer'),
      '@xibosignage/xibo-communication-framework': resolve(__dirname, '../xibo-communication-framework'),
    };
  }

  return {
    main: {
      server: {
        hmr: false,
      },
      define: versionDefine,
      build: {
        externalizeDeps: {exclude: devLibraries},
        sourcemap: true,
        minify: false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            express: resolve(__dirname, 'src/main/express.ts'),
          },
          external: ['better-sqlite3'],
        },
      },
      resolve: {
        alias: {
          ...alias,
        },
      },
      optimizeDeps: {
        exclude: devLibraries,
      },
    },
    preload: {
      build: {
        externalizeDeps: {exclude: devLibraries},
        bytecode: true,
        rollupOptions: {
          external: [],
        },
      },
      resolve: {
        alias: {
          ...alias,
        },
      },
    },
    renderer: {
      server: {
        hmr: false,
      },
      define: versionDefine,
      plugins: [
        {
          name: 'html-transform',
          transformIndexHtml(html) {
            return html.replace(/%__APP_VERSION__%/g, packageJson.version);
          },
        },
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('./src/shared'),
          ...alias,
        },
      },
      optimizeDeps: {
        exclude: devLibraries,
      },
    },
  };
});
