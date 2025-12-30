/*
 * Copyright (c) 2025 Xibo Signage Ltd
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
import express from 'express';
import corsImport from 'cors';
import fs from 'fs/promises';
import fsSync from 'fs';

import { Config } from './config/config';

const cors = (corsImport as any).default ?? corsImport;
const port = 9696;
let isListening = false;

export async function createFileServer(config: Config) {
  const server = express();
  // Use the cors middleware
  server.use(cors());

  // Parse JSON request bodies
  server.use(express.json());

  const xiboLibDir = config.getSetting('library');

  // Ensure the library path exists
  if (!fsSync.existsSync(xiboLibDir)) {
    await fs.mkdir(xiboLibDir, { recursive: true });
  }

  server.get('/', (_req, res) => {
    res.send('Hello World!');
  });

  // Optional: list all files if /files/ is accessed directly
  server.get('/files', (_req, res) => {
    const files = fsSync.readdirSync(xiboLibDir);
    res.json({
      files,
      count: files.length,
      message: 'Use /files/<filename> to access individual files',
    });
  });

  server.use('/files', express.static(xiboLibDir));

  if (!isListening) {
    server.listen(port, () => {
      isListening = true;
      console.log(`Xibo File Server listening on port ${port}`);
    });
  }
}
