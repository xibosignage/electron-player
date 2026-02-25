/*
 * Copyright (c) 2026 Xibo Signage Ltd
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
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { defineConfig, externalizeDepsPlugin, bytecodePlugin, loadEnv }
  from 'electron-vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const swLastBuildUpdate = new Date().toISOString();

  // Read package.json
  const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));

  let rollupOptions = {};
  let alias = {};

  if (mode !== 'production') {
    rollupOptions = {
      external: ['@xibosignage/xibo-layout-renderer'],
    };
    // Only alias if the environment variable is set to true
    if (env.VITE_ALIAS_LIBRARIES === 'true') {
      alias = {
        '@xibosignage/xibo-layout-renderer': resolve(__dirname, '../xibo-layout-renderer'),
      };
    }
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      build: {
        sourcemap: true,
        minify: false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            express: resolve(__dirname, 'src/main/express.ts'),
          },
          external: ['better-sqlite3', ...(rollupOptions?.external || [])],
        },
      },
      resolve: {
        alias: {
          ...alias,
        },
      },
      define: {
        __LAST_BUILD_UPDATE__: JSON.stringify(swLastBuildUpdate),
        __APP_VERSION__: JSON.stringify(packageJson.version),
        __APP_VERSION_CODE__: packageJson.versionCode || 0,
      },
    },
    preload: {
      build: {
        rollupOptions: {
          external: rollupOptions?.external || [],
        },
      },
      resolve: {
        alias: {
          ...alias,
        },
      },
      plugins: [externalizeDepsPlugin(), bytecodePlugin()],
    },
    renderer: {
      plugins: [
        {
          name: 'html-transform',
          transformIndexHtml(html) {
            return html.replace(
              /%VITE_APP_VERSION%/g,
              packageJson.versionCode || 0,
            );
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
        exclude: rollupOptions?.external || [],
      },
    },
  };
});
