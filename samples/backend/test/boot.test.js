/* ══════════════════════════════════════════════════════════════════════════
   The entry point actually starts.

   Every other suite builds the Express app directly — `require('../app')(db)`
   — which is fast, isolated, and blind to everything bin/www does around it:
   reading configuration, applying the schema before listening, and shutting
   down on SIGTERM. That blindness has been paid for once. bin/www read a
   configuration key no file defined and called a service that did not exist,
   so the container exited 1 on boot in every environment while all three
   suites stayed green — the API was only ever reached in-process, and the
   process nobody started was the one the image runs.

   So this suite starts the real thing, as a child process, the way the
   container does.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', 'bin', 'www');

/* Not 3000: a developer with the dev stack up is the likeliest person to run
   this, and taking their API's port would fail the suite for a reason that
   has nothing to do with the code. PORT=0 is not available — bin/www reads
   `Number(process.env.PORT) || 3000`, and 0 is falsy. */
const PORT = Number(process.env.BOOT_TEST_PORT) || 3199;

function get(url) {
  return new Promise((done) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => done({ status: res.statusCode, body }));
    });
    req.on('error', (err) => done({ status: 0, body: String(err) }));
    req.setTimeout(2000, () => { req.destroy(); done({ status: 0, body: 'timeout' }); });
  });
}

test('bin/www boots, serves /health, and stops on SIGTERM', async (t) => {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(PORT),
           NODE_CONFIG: '{"log_level":"silent"}' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  /* Kept so a failure can say WHY it never came up — a boot that dies on a
     missing configuration key says exactly that, and an assertion reading
     "expected 200, got 0" does not. */
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const exited = new Promise((done) => child.on('exit', (code) => done(code)));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

  /* It does not listen until db.init() has resolved, so "connection refused"
     here means genuinely not ready rather than ready-and-broken. Poll. */
  const deadline = Date.now() + 20000;
  let health = { status: 0, body: '' };
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    health = await get(`http://127.0.0.1:${PORT}/health`);
    if (health.status === 200) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  assert.strictEqual(health.status, 200,
    `bin/www never served /health. It ${child.exitCode !== null
      ? `exited ${child.exitCode}` : 'was still running'}:\n${output}`);
  assert.match(health.body, /"status"\s*:\s*"ok"/);

  /* Compose sends SIGTERM on every deploy. A clean exit is what keeps a
     release from leaving a half-written transaction behind. */
  child.kill('SIGTERM');
  const code = await Promise.race([
    exited,
    new Promise((done) => setTimeout(() => done('timed out'), 12000))
  ]);
  assert.strictEqual(code, 0, `expected a clean exit on SIGTERM, got ${code}`);
});
