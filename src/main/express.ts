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
import { Config } from './config/config';

const fs = require('fs/promises');
const fsSync = require('fs');
const cors = require('cors');
const server = express();
const port = 9696;

export async function createFileServer(config: Config) {
  // Use the cors middleware
  server.use(cors());

  // Parse JSON request bodies
  server.use(express.json());

  const xiboLibDir = config.getSetting('library');

  // Ensure the library path exists
  if (!fsSync.existsSync(xiboLibDir)) {
    await fs.mkdir(xiboLibDir, {recursive: true});
  }

  server.get('/', (req, res) => {
    res.send('Hello World!');
  });

  server.use('/files', express.static(xiboLibDir));

  // Optional: list all files if /files/ is accessed directly
  server.get('/files', (req, res) => {
    const files = fsSync.readdirSync(xiboLibDir);
    res.json({
      files,
      count: files.length,
      message: 'Use /files/<filename> to access individual files',
    });
  });

  server.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
  });

  server.on('listening', () => console.log(`Listening on: ${port}`));
  server.on('close', () => console.log('Express server closed.'));
}
