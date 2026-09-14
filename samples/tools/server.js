/* ══════════════════════════════════════════════════════════════════════════
   Minimal static file server — no dependencies.

   Serves `frontend/` as the document root, which is exactly what the web
   container ships — `/` is the landing page and `/app.html` the application
   — plus two mounts that live outside it and one proxy:

     /shared/…   the rules engine and date helpers the backend require()s too
     /docs/…     the user manual PDF, linked from every sidebar — and only
                 that: see MOUNTS
     /v1/api/…   proxied to the API

   The proxy is the point rather than a convenience. The session lives in a
   SameSite=Lax cookie, so serving the app and the API from one origin means
   the cookie simply works, there is no CORS preflight on every request, and
   no third-party-cookie policy to fall foul of. The production web container
   does the same thing, so what is tested here is what ships.

   Keeping the same three mappings here and in the image means a URL that
   works in development works in production — there is no build step to paper
   over a difference. The corollary is that every policy here is a production
   policy, whether or not it was chosen as one; see the note on caching below.

   Not a general-purpose web server. It serves files, answers conditional and
   range requests, and proxies. Compression is traefik's job in front of it.

   Run standalone:  node tools/server.js [port]
   Or import:       const { start } = require('./server');
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const http_ = http;                       // named for the proxy below
const REPO = path.join(__dirname, '..');

/** Where the API lives. Overridden in a container by API_ORIGIN. */
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:3000';

/* Loopback by default, because a development server has no business being
   reachable from the network. The container sets HOST=0.0.0.0, where the
   network boundary is the container's rather than the interface's. */
const HOST = process.env.HOST || '127.0.0.1';
const API_PREFIX = '/v1/api';
const ROOT = path.join(REPO, 'frontend');

/* Prefix → directory on disk, with an optional `only` predicate the resolved
   path must satisfy. Longest match wins; anything else is served from the
   document root.

   `docs/` is a working directory, not a public one: beside the manual PDF it
   holds the manual's source, every screenshot, and the conventions this
   codebase is written to — which describe the access model and the shape of
   the deployment to anybody who asks. Mounting the directory published all of
   it. What the app links to is one file, so that is what the mount serves: a
   top-level PDF and nothing else, which survives the manual being renamed
   without needing a constant shared with the build. */
const MOUNTS = [
  ['/shared/', path.join(REPO, 'shared')],
  ['/docs/', path.join(REPO, 'docs'), (rel) => /^[^/\\]+\.pdf$/i.test(rel)]
];

/**
 * Is `file` inside `dir`?
 *
 * A bare `startsWith` is not containment: `/repo/frontend-secrets` starts
 * with `/repo/frontend`, so a sibling directory whose name merely extends the
 * mount's would have been served. The separator is what makes it a boundary.
 */
function inside(file, dir) {
  return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

/** Resolve a URL path to a file, refusing anything that escapes its mount. */
function resolve(rel) {
  for (const [prefix, dir, only] of MOUNTS) {
    if (rel.startsWith(prefix)) {
      const within = path.normalize(rel.slice(prefix.length));
      /* Checked on the normalised path, so `/docs/agents/../x.pdf` is judged
         as what it resolves to rather than as what it was typed as. */
      if (only && !only(within.split(path.sep).join('/'))) return null;
      const file = path.join(dir, within);
      return inside(file, dir) ? file : null;
    }
  }
  const file = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  return inside(file, ROOT) ? file : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  /* robots.txt, and anything else a crawler asks for by name. Without a type
     it would be served as application/octet-stream, which a browser offers to
     save rather than display and a crawler is entitled to ignore — a landing
     page's SEO undone by a missing line in a lookup table. */
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2'
};

/**
 * Hand a request straight to the API, headers and body untouched.
 *
 * Cookies and the CSRF header have to survive verbatim, so nothing is
 * rewritten on the way through except the Host.
 */
function proxy(req, res) {
  const target = new URL(API_ORIGIN);
  const headers = { ...req.headers, host: target.host };
  delete headers['accept-encoding'];      // no need to re-encode a passthrough

  const upstream = http_.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });

  upstream.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'api_unreachable', detail: err.message }));
  });

  req.pipe(upstream);
}

/* ── Caching ───────────────────────────────────────────────────────────────
   Validation, not expiry.

   The application has no build step, so `js/app.js` is `js/app.js` for ever
   — there is no content hash in the name to invalidate on a deploy. That
   rules out a long `max-age`: a browser holding last week's `app.js` would
   have no way of finding out. So every response carries validators and
   `no-cache`, which does not mean "do not store" — it means store it, and
   ask before using it. The reply to that question is a 304 with no body.

   This used to be `no-store`, which is the honest answer for a development
   server and quietly the wrong one in production: it re-sent the whole
   application, and the 20 MB manual, on every single page load. Serving the
   same code in both places is what made that easy to miss, so the policy has
   to be right for both — and validation is, because a file that changed has
   a different validator and comes back in full.
   ──────────────────────────────────────────────────────────────────────── */

/** A file's identity: its size and modification time, which is what nginx uses. */
function etagFor(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
}

/** Whether the client already holds this exact version. */
function isCurrent(req, etag, mtime) {
  const noneMatch = req.headers['if-none-match'];
  /* An entity tag answers precisely, so it wins outright when present —
     including when it does *not* match, where falling through to the date
     would let a coarser check contradict it. */
  if (noneMatch) {
    return noneMatch.split(',').some((t) => t.trim() === etag || t.trim() === 'W/' + etag);
  }
  const since = req.headers['if-modified-since'];
  if (!since) return false;
  const at = Date.parse(since);
  // Last-Modified has one-second resolution, so compare at that resolution.
  return !Number.isNaN(at) && Math.floor(mtime.getTime() / 1000) <= Math.floor(at / 1000);
}

/**
 * One `Range: bytes=…` header, as an inclusive [start, end] within `size`.
 *
 * Returns null when there is nothing to honour and `false` when the client
 * asked for something outside the file, which is a 416 rather than the whole
 * thing. Multiple ranges are not implemented; a server may always answer a
 * range request with the entire representation, and that is what happens.
 */
function rangeOf(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  let start;
  let end;
  if (rawStart === '') {
    if (rawEnd === '') return null;
    const wanted = Number(rawEnd);                 // the last N bytes
    if (wanted === 0) return false;
    start = Math.max(0, size - wanted);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start > end || start >= size) return false;
  return [start, end];
}

/** Send a file, answering conditional and range requests properly. */
function serve(req, res, file, stat) {
  const etag = etagFor(stat);
  const mtime = new Date(stat.mtime);
  const base = {
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': mtime.toUTCString(),
    'Accept-Ranges': 'bytes'
  };

  if (isCurrent(req, etag, mtime)) {
    // 304 carries the validators and no body — not even a Content-Length.
    res.writeHead(304, base);
    res.end();
    return;
  }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.method === 'GET' ? rangeOf(req.headers.range, stat.size) : null;

  if (range === false) {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }

  const [start, end] = range || [0, stat.size - 1];
  const headers = {
    ...base,
    'Content-Type': type,
    'Content-Length': stat.size === 0 ? 0 : end - start + 1
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;

  // A HEAD reply carries the headers and no body. Writing the buffer and
  // letting Node strip it leaves Chrome aborting the connection, so end the
  // response explicitly instead.
  if (req.method === 'HEAD' || stat.size === 0) {
    res.writeHead(range ? 206 : 200, headers);
    res.end();
    return;
  }

  res.writeHead(range ? 206 : 200, headers);
  /* Streamed rather than read whole: the manual is 20 MB, and buffering it
     per request is a cost paid on a file nobody edits. */
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function start(port = 5173) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith(API_PREFIX)) return proxy(req, res);

    let rel = decodeURIComponent(req.url.split('?')[0]);
    /* `/` is the LANDING PAGE — frontend/index.html — and the application
       lives at `/app.html`. Two different documents on purpose: the app boots
       by asking who you are, and a marketing page that did that would answer
       401 to every visitor before painting anything.

       This mapping is the only thing serving the bare URL, and it is
       load-bearing twice over: both containers' HEALTHCHECK fetches `/` and
       expects 200, so pointing it at a file that does not exist leaves a
       container that serves every real request correctly and is still
       reported unhealthy for ever — which a deploy that waits on health reads
       as a failed release and rolls back.

       That happened once already with this line pointing at an index.html
       the app did not have. The rule it left behind: whatever `/` resolves
       to, the browser suite fetches it and asserts 200, because the
       healthcheck cannot. */
    if (rel === '/') rel = '/index.html';

    /* Keep every request inside the directory its mount points at, and
       inside what that mount is willing to serve.

       Answered as a 404 rather than a 403, for the reason the API answers a
       record somebody may not read exactly as it answers one that does not
       exist: «Forbidden» on `/docs/agents/backend.md` confirms the file is
       there, and a refusal that names what it is refusing is a directory
       listing read one path at a time. */
    const file = resolve(rel);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found: ' + rel);
      return;
    }

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found: ' + rel);
        return;
      }
      serve(req, res, file, stat);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, HOST, () => resolve({
      server, port, host: HOST,
      url: `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${port}`
    }));
  });
}

module.exports = { start, ROOT, REPO, API_ORIGIN, API_PREFIX, HOST };

if (require.main === module) {
  const port = Number(process.argv[2]) || 5173;
  start(port).then(({ url }) => console.log(`Acme demo served at ${url}  (Ctrl+C to stop)`));
}
