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
import XiboLayoutRenderer, {IXlr, OptionsType} from '@xibosignage/xibo-layout-renderer';
import DefaultLayout from './layout/defaultLayout';

window.electron.onConfigure((config) => {
  console.log('onConfigure');
  window.config = config;
  const $config = $('#config');

  if (config.cmsUrl) {
    console.log('onConfigure: we have a URL, hide the config.');
    $config.hide();

    const xlrOptions: Partial<OptionsType> = {
      platform: 'chromeOS',
      config: {
        cmsUrl: window.location.origin,
        cmsKey: config.cmsKey,
        schemaVersion: config.schemaVersion,
        hardwareKey: config.hardwareKey,
      },
      icons: {
        splashScreen: 'assets/logo.png',
        logo: 'assets/logo.png',
      },
    };
    
    // Create a splash screen
    const splash = new DefaultLayout();
    splash.path = '0.xlf';

    let xlr: IXlr = XiboLayoutRenderer([splash], xlrOptions as any);
    xlr.init().then((response: any) => {
      console.log('onConfigure: play schedules');
      console.log(response);
      xlr.playSchedules(response);
    });
  } else {
    // Show the configure view
    console.log('onConfigure: show configure view');
    $config.show();
    $config.find('.code').show();
  }
});
