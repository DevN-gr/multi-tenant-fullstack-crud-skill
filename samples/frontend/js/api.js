/* ══════════════════════════════════════════════════════════════════════════
   API — the only thing in the browser that talks to the server.

   Every request carries the session cookie (`credentials: 'include'`), which
   is why the API names its allowed origins exactly rather than using a
   wildcard. The session token itself is httpOnly and unreachable from here;
   what this file does hold is the CSRF token, which authorises nothing on its
   own and has to be readable so it can be echoed back in a header.

   Errors come back as a value, not an exception: `{ ok, status, data, error }`.
   A view showing a booking conflict and a view showing a network outage are
   both handling an expected outcome, and try/catch around every call would
   bury that.

   One 401 retry: an access token lasts thirty minutes, so an idle tab's next
   click routinely lands on an expired one. It refreshes once, silently, and
   replays the request. A second failure means the session is genuinely over.
   ═══════════════════════════════════════════════════════════════════════ */
window.API = (function () {
  'use strict';

  /* Same-origin by default: the web container serves the app and proxies the
     API, so there is nothing to configure. A separate API host is set once,
     before the app boots, by defining window.APP_API. */
  var BASE = (window.APP_API || '') + '/v1/api';

  var CSRF_COOKIE = 'acme_csrf';
  var CSRF_HEADER = 'X-CSRF-Token';

  var listeners = { unauthorized: [] };
  var refreshing = null;

  /**
   * Endpoints where a 401 is the answer rather than a stale session.
   *
   * Signing in with the wrong password returns 401 — and refreshing a session
   * that does not exist, then reporting "unauthenticated", would replace
   * "wrong password" with a redirect to the screen the user is already on.
   * The refresh endpoint is here for the obvious reason: retrying a refresh
   * with a refresh is a loop.
   */
  var NO_REFRESH = [
    '/auth/login', '/auth/refresh', '/auth/logout',
    '/auth/forgot-password', '/auth/reset-password',
    '/auth/accept-invite', '/auth/verify-email'
  ];

  function retryable(path) {
    var bare = path.split('?')[0];
    for (var i = 0; i < NO_REFRESH.length; i++) {
      if (bare === NO_REFRESH[i]) return false;
    }
    return true;
  }

  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
    return function () {
      listeners[event] = listeners[event].filter(function (f) { return f !== fn; });
    };
  }

  function emit(event, payload) {
    (listeners[event] || []).slice().forEach(function (fn) { fn(payload); });
  }

  /** The CSRF token the server set. Readable on purpose — see the header. */
  function csrfToken() {
    var match = document.cookie.match(new RegExp('(^|;\\s*)' + CSRF_COOKIE + '=([^;]*)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  /** Build a query string, dropping anything the caller left empty. */
  function query(params) {
    if (!params) return '';
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) {
        value.forEach(function (v) {
          parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
        });
        return;
      }
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function send(method, path, body, options) {
    options = options || {};
    var headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    var token = csrfToken();
    if (token && method !== 'GET') headers[CSRF_HEADER] = token;

    return fetch(BASE + path, {
      method: method,
      headers: headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
        return { res: res, data: data };
      });
    }).then(function (result) {
      var res = result.res, data = result.data;

      if (res.status === 401 && !options.noRetry && retryable(path)) {
        return refreshOnce().then(function (renewed) {
          if (!renewed) {
            emit('unauthorized');
            return { ok: false, status: 401, data: null, error: 'unauthenticated' };
          }
          return send(method, path, body, { noRetry: true });
        });
      }

      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          data: data,
          error: (data && data.error) || 'request_failed'
        };
      }
      return { ok: true, status: res.status, data: data, error: null };
    }, function (networkError) {
      /* fetch only rejects when the request never completed. */
      return { ok: false, status: 0, data: null, error: 'offline', detail: networkError.message };
    });
  }

  /**
   * Ask for a file rather than for JSON.
   *
   * An export is the one answer this API gives that is not a record: it is
   * a binary file, and reading it through `send` would decode it as UTF-8
   * text and hand back the wreckage. So the response is taken as a Blob and
   * the name to save it under comes back beside it.
   *
   * Errors still arrive as JSON, because a refusal is a record.
   */
  function download(method, path, body, options) {
    options = options || {};
    var headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    var token = csrfToken();
    if (token && method !== 'GET') headers[CSRF_HEADER] = token;

    return fetch(BASE + path, {
      method: method,
      headers: headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401 && !options.noRetry && retryable(path)) {
        return refreshOnce().then(function (renewed) {
          if (!renewed) {
            emit('unauthorized');
            return { ok: false, status: 401, data: null, error: 'unauthenticated' };
          }
          return download(method, path, body, { noRetry: true });
        });
      }

      if (!res.ok) {
        return res.text().then(function (text) {
          var data = null;
          if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
          return {
            ok: false, status: res.status, data: data,
            error: (data && data.error) || 'request_failed'
          };
        });
      }

      return res.blob().then(function (blob) {
        return {
          ok: true, status: res.status, error: null,
          blob: blob,
          filename: filenameFrom(res.headers.get('Content-Disposition')),
          headers: res.headers
        };
      });
    }, function (networkError) {
      return { ok: false, status: 0, data: null, error: 'offline', detail: networkError.message };
    });
  }

  /**
   * Send a file, and say how far it has got.
   *
   * `fetch` cannot report upload progress — there is no event for it — and a
   * hundred-megabyte upload with no bar is indistinguishable from a hung one.
   * So this is the one request in the app made with XMLHttpRequest, which has
   * had `upload.onprogress` since long before fetch existed.
   *
   * The body is the file itself rather than a multipart form: there is one
   * file per request, the server writes it straight to disk, and a parser in
   * between would buy nothing but a dependency.
   *
   * @param {string} path
   * @param {Blob|File} file
   * @param {function} [onProgress] - (fraction 0..1, loaded, total)
   * @param {string} [method] - POST unless the route says otherwise. It is a
   *   parameter because this was hard-coded once and the one caller that
   *   needed PUT got a 404 on every byte it sent — a route that does not
   *   exist and a route that refuses look identical from here.
   * @returns {Promise<{ok, status, data, error}>}
   */
  function upload(path, file, onProgress, method) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open(method || 'POST', BASE + path, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      var token = csrfToken();
      if (token) xhr.setRequestHeader(CSRF_HEADER, token);

      if (onProgress) {
        xhr.upload.onprogress = function (ev) {
          if (ev.lengthComputable) onProgress(ev.loaded / ev.total, ev.loaded, ev.total);
        };
      }

      xhr.onload = function () {
        var data = null;
        if (xhr.responseText) {
          try { data = JSON.parse(xhr.responseText); } catch (e) { data = xhr.responseText; }
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true, status: xhr.status, data: data, error: null });
          return;
        }
        resolve({
          ok: false, status: xhr.status, data: data,
          error: (data && data.error) || 'request_failed'
        });
      };

      /* Only fires when the request never completed at all. */
      xhr.onerror = function () {
        resolve({ ok: false, status: 0, data: null, error: 'offline' });
      };
      xhr.onabort = function () {
        resolve({ ok: false, status: 0, data: null, error: 'upload_cancelled' });
      };

      xhr.send(file);
    });
  }

  /** `attachment; filename="export-2026-08-25.json.gz"` → the name. */
  function filenameFrom(disposition) {
    var match = /filename="([^"]+)"/.exec(disposition || '');
    return match ? match[1] : null;
  }

  /**
   * Renew the session, at most once at a time. Several requests failing
   * together — which is what a dashboard does — must share one refresh
   * rather than each rotating the token and invalidating the others.
   */
  function refreshOnce() {
    if (refreshing) return refreshing;
    refreshing = send('POST', '/auth/refresh', {}, { noRetry: true })
      .then(function (result) { return result.ok; })
      .then(function (ok) { refreshing = null; return ok; },
        function () { refreshing = null; return false; });
    return refreshing;
  }

  return {
    get: function (path, params) { return send('GET', path + query(params)); },
    post: function (path, body) { return send('POST', path, body === undefined ? {} : body); },
    put: function (path, body) { return send('PUT', path, body === undefined ? {} : body); },
    del: function (path) { return send('DELETE', path); },
    download: function (path, body) { return download('POST', path, body === undefined ? {} : body); },
    upload: upload,
    query: query,
    csrfToken: csrfToken,
    on: on,
    BASE: BASE
  };
})();
