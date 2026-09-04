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
import { app, session } from 'electron';

import { ProxyConfig } from '../config/config';

/**
 * Never proxy the embedded file server or anything else on the loopback interface — the
 * renderer fetches every local media asset over http://localhost:9696.
 */
const BYPASS_HOSTS = 'localhost,127.0.0.1,::1';

let loginHandlerAttached = false;

/**
 * Route the player's outbound traffic through an upstream HTTP proxy.
 *
 * The legacy 1.8 Linux player supported a proxy (cmsSettings.xml domain/username/password);
 * devices migrated from it will not reach their CMS without this.
 *
 * Two separate stacks need configuring:
 *  - Chromium (the renderer, and anything fetched by a layout) via session.setProxy().
 *  - Node (XMDS/SOAP and file downloads all go through axios in the main process), which
 *    reads the standard HTTP_PROXY/HTTPS_PROXY environment variables.
 */
export async function applyProxyConfig(proxy: ProxyConfig | null): Promise<void> {
  if (!proxy?.url) {
    return;
  }

  try {
    // Node side. axios uses these automatically when no explicit `proxy` option is set.
    const withCredentials = buildProxyUrlWithCredentials(proxy);
    process.env.HTTP_PROXY = withCredentials;
    process.env.HTTPS_PROXY = withCredentials;
    process.env.http_proxy = withCredentials;
    process.env.https_proxy = withCredentials;
    process.env.NO_PROXY = BYPASS_HOSTS;
    process.env.no_proxy = BYPASS_HOSTS;

    // Chromium side. Credentials are supplied via the 'login' event rather than the URL.
    await session.defaultSession.setProxy({
      proxyRules: proxy.url,
      proxyBypassRules: BYPASS_HOSTS,
    });

    attachProxyLoginHandler(proxy);

    console.log(`[Proxy] Routing traffic via ${proxy.url} (auth: ${Boolean(proxy.username)})`);
  } catch (err) {
    console.error('[Proxy] Failed to apply proxy configuration:', err);
  }
}

/**
 * Answer proxy authentication challenges raised by Chromium. Only responds to proxy
 * challenges — origin-server challenges are left alone.
 */
function attachProxyLoginHandler(proxy: ProxyConfig): void {
  if (loginHandlerAttached || !proxy.username) return;

  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;

    event.preventDefault();
    callback(proxy.username, proxy.password ?? '');
  });

  loginHandlerAttached = true;
}

function buildProxyUrlWithCredentials(proxy: ProxyConfig): string {
  if (!proxy.username) return proxy.url;

  try {
    const url = new URL(proxy.url);
    url.username = encodeURIComponent(proxy.username);
    url.password = encodeURIComponent(proxy.password ?? '');
    return url.toString();
  } catch {
    return proxy.url;
  }
}
