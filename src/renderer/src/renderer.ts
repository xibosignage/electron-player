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
import './assets/main.css';
import $ from 'jquery';

window.electron.onShowConfigure((config) => {
  console.log('onShowConfigure');

  const $config = $('#config');
  $config.show();
  $config.find('.code').show();

  // Make a request to the "Use Code" API.
  $.ajax('https://auth.signlicence.co.uk/generateCode', {
    type: 'POST',
    dataType: 'json',
    data: {
      hardwareId: config.hardkwareKey,
      type: config.platform,
      version: config.versionNumber,
    },
    success: (data) => {
      console.log(data);

      // Hide the loader and show the code.
    },
    error: (xhr) => {
      console.log(xhr);

      // Configure manually.
      $config.find('.code').hide();
      $config.find('.manual').show();
    },
  });
});
