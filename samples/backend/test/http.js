/* ══════════════════════════════════════════════════════════════════════════
   A tiny HTTP client for the suite.

   Real requests against a real listening app, because the things worth
   asserting here — cookies, CSRF, the 401/403/422 a client actually sees —
   only exist at that layer. Calling a controller hook directly would test
   the hook and miss the wiring.

   Each `agent()` keeps its own cookie jar, so several roles can be signed in
   at once and every test can say "as the front desk" or "as this member"
   without tearing the session down between assertions.

   Every request is bounded. A request that is never answered is not a slow
   test, it is a broken server — the failure this suite exists to catch on
   the /auth routes is exactly that, a handler whose rejection means no
   response is ever sent. Left unbounded it stalls the runner until the CI
   job's own timeout, which reads as "the build hung" rather than as the
   assertion that actually failed.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { once } = require('node:events');
const http = require('node:http');

async function listen(app) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A client with its own cookies. */
function agent(base) {
  const jar = new Map();
  let csrfToken = null;

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  function absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    raw.forEach((line) => {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' ) jar.delete(name); else jar.set(name, value);
    });
    if (jar.has('acme_csrf')) csrfToken = jar.get('acme_csrf');
  }

  /* Generous — provisioning a demo tenant seeds a whole practice — but far
     below any plausible CI timeout, so a hang fails as a hang. */
  const TIMEOUT_MS = 30000;

  async function request(method, path, body, options = {}) {
    const headers = {};
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const timeoutMs = options.timeoutMs || TIMEOUT_MS;
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(
          `${method} ${path} was never answered (${timeoutMs}ms). The server ` +
          'accepted the request and sent no response — check for a handler ' +
          'whose rejection escapes Express instead of reaching the error middleware.'
        );
      }
      throw err;
    }
    absorb(res);

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /**
   * The same request, answered as bytes.
   *
   * An export is a gzipped file, and reading it as text would decode it as
   * UTF-8 and change it — which is exactly what a checksum assertion is for.
   */
  async function raw(method, path, body) {
    const headers = {};
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const res = await fetch(base + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    absorb(res);
    return {
      status: res.status,
      headers: res.headers,
      buffer: Buffer.from(await res.arrayBuffer())
    };
  }

  /** Send bytes as the body — a bundle is a file, not a document. */
  async function sendBytes(method, path, buffer, contentType) {
    const headers = { 'content-type': contentType || 'application/gzip' };
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;

    const res = await fetch(base + path, {
      method, headers, body: buffer, duplex: 'half',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    absorb(res);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    raw,
    sendBytes,
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
    put: (p, b, o) => request('PUT', p, b === undefined ? {} : b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
    request,
    jar,
    /** Drop the CSRF header on the next call, to prove the guard bites. */
    forgetCsrf() { csrfToken = null; },
    setCsrf(v) { csrfToken = v; }
  };
}

module.exports = { listen, agent };
