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

/**
 * Escape the connector source so it can be inlined inside a <script> element.
 * Script content may not contain a closing script tag or an HTML comment open.
 */
function escapeScriptContent(js: string) {
    return js
        .replace(/<\/(script)/gi, '<\\/$1')
        .replace(/<!--/g, '<\\!--');
}

/**
 * Build the srcdoc document hosting a data connector.
 *
 * The document runs inside a sandboxed iframe (`sandbox="allow-scripts"`,
 * opaque origin) — the same environment the CMS data connector test harness
 * uses — and bridges the `window.xiboDC` API to the player via postMessage.
 * The connector source is inlined because a sandboxed document cannot load the
 * cached script itself.
 *
 * This is shared verbatim with the ChromeOS player so a connector validated on
 * one platform behaves identically on the other. The opaque-origin sandbox is
 * what keeps connector code away from Electron/Node APIs even though the host
 * BrowserWindow has node access — the iframe never inherits it.
 *
 * @param connectorJs The connector source (already integrity-checked in main)
 */
export function buildHostPage(connectorJs: string) {
    const bridge = `
window.xiboDC = (function() {
  'use strict';

  var nextRequestId = 1;
  var pending = {};

  function send(msg) {
    msg.from = 'xiboDC';
    window.parent.postMessage(msg, '*');
  }

  window.addEventListener('message', function(event) {
    var data = event.data || {};

    if (data.type === 'init') {
      window.xiboDC.initialise(data.id, data.params.data);
    } else if (data.type === 'response') {
      var callbacks = pending[data.requestId];
      delete pending[data.requestId];

      if (!callbacks) {
        return;
      }

      if (data.success) {
        if (typeof (callbacks.done) == 'function') {
          callbacks.done(data.status, data.data);
        }
      } else {
        if (typeof (callbacks.error) == 'function') {
          callbacks.error(data.status, data.data);
        }
      }
    }
  });

  var mainLib = {
    /**
     * Inject the data connector event parameters and dataSetId
     * @param {string} dataSetId - The id of the dataset
     * @param {string} dataSetParameters - A url string of parameters
     */
    initialise: function(dataSetId, dataSetParameters) {
      window.dataSetId = dataSetId;
      new URLSearchParams(dataSetParameters).forEach(function(value, key) {
        window[key] = value;
      });

      if (typeof (window.onInit) == 'function') {
        window.onInit();
      }
    },

    /**
     * Set this displays tags. Called by the player host.
     * @param {string} displayTags A JSON object containing the display tags
     */
    setDisplayTags: function(displayTags) {
      window.displayTags = displayTags;
    },

    /**
     * Set the realtime data into the player. Called from Data Connector.
     * @param {string} dataKey A dataKey to store this data
     * @param {String} data The data as string
     * @param {Object} options - Request options
     * @param {callback} options.done Optional
     * @param {callback} options.error Optional
     */
    setData: function(dataKey, data, {done, error} = {}) {
      var requestId = nextRequestId++;
      pending[requestId] = {
        done: function() {
          if (typeof (done) == 'function') {
            done(true);
          }
        },
        error: error,
      };
      send({type: 'set', requestId: requestId, dataKey: dataKey, data: data});
    },

    /**
     * Notify main application that we have new data. Called from data connector.
     * @param {string} dataKey - The key of the data that has been changed.
     */
    notifyHost: function(dataKey) {
      send({type: 'notify', dataKey: dataKey});
    },

    /**
     * Make a request via the player.
     * Note: handled by the player with fetch() and therefore subject to CORS,
     * unlike native players which use a native HTTP stack.
     * @param  {string} path - Request path
     * @param  {Object} [options] - Optional params
     * @param  {string} [options.type]
     * @param  {Object[]} [options.headers]
     *  Request headers in the format {key: key, value: value}
     * @param  {Object} [options.data]
     * @param  {callback} [options.done]
     * @param  {callback} [options.error]
     */
    makeRequest: function(path, {type, headers, data, done, error} = {}) {
      var requestId = nextRequestId++;
      pending[requestId] = {done: done, error: error};
      send({
        type: 'request',
        requestId: requestId,
        path: path,
        options: {type: type, headers: headers, data: data},
      });
    },

    /**
     * Set Schedule Criteria
     * @param {string} metric The Metric Name
     * @param {string} value The Value
     * @param {int} ttl A TTL in seconds
     */
    setCriteria: function(metric, value, ttl) {
      send({
        type: 'criteria',
        dataKey: metric,
        data: {
          metric: metric,
          value: value || null,
          ttl: ttl,
        },
      });
    },
  };
  return mainLib;
})();

// Capture console logs and report out.
(function() {
  var log = console.log;
  console.log = function() {
    log.apply(this, Array.prototype.slice.call(arguments));
    try {
      window.parent.postMessage({
        from: 'xiboDC',
        type: 'log',
        data: Array.prototype.slice.call(arguments),
      }, '*');
    } catch (e) {
      // Arguments not cloneable, ignore.
    }
  };
}());

// Surface connector exceptions to the player (the sandbox hides them otherwise).
window.onerror = function(message, source, line) {
  window.parent.postMessage({
    from: 'xiboDC',
    type: 'error',
    message: String(message),
    line: line,
  }, '*');
};

// Say when we're loaded.
window.onload = function() {
  window.parent.postMessage({from: 'xiboDC', type: 'loaded'}, '*');
};
`;

    return '<!DOCTYPE html>'
        + '<html>'
        + '<head><meta charset="utf-8"><title>Xibo Data Connector</title></head>'
        + '<body>'
        + '<script type="text/javascript">' + bridge + '</script>'
        + '<script type="text/javascript">'
        + escapeScriptContent(connectorJs)
        + '</script>'
        + '</body>'
        + '</html>';
}
