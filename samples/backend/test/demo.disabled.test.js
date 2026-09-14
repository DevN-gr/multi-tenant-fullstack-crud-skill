/* ══════════════════════════════════════════════════════════════════════════
   The demo, switched off — which is how it ships.

   Its own file because the setting is read from the configuration, and
   node:test gives each file its own process: this is the one that boots with
   `demo.enabled` false, and demo.test.js is the one that boots with it true.
   Between them they cover both states without either mutating configuration
   at runtime, which node-config freezes anyway.

   What is being proved is that a feature nobody turned on looks like a
   feature nobody wrote.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

process.env.NODE_ENV = 'test';
process.env.NODE_CONFIG = JSON.stringify({
  log_level: 'silent',
  demo: { enabled: false, ttl_hours: 24, max_live: 25, per_ip_minutes: 10, sweep_minutes: 15 }
});

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { bootOnce } = require('./helpers');
const { listen, agent } = require('./http');
const demo = require('../services/demo');

let ctx, server, base;

before(async () => {
  ctx = await bootOnce();
  const app = require('../app')(ctx.db);
  ({ server, base } = await listen(app));
});

after(async () => { server.close(); });

describe('with the demo switched off', () => {
  test('the door answers 404, not 403', async () => {
    const res = await agent(base).post('/v1/api/demo');
    /* 403 would tell an unauthenticated caller that this deployment HAS a
       demo endpoint and that it is merely closed — an invitation to keep
       asking, and a detail about the deployment that nobody outside it is
       owed. Same reasoning as a record you may not read. */
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  });

  test('nothing was written on the way to refusing', async () => {
    const before = await ctx.db.Organization.count({ paranoid: false });
    await agent(base).post('/v1/api/demo');
    assert.equal(await ctx.db.Organization.count({ paranoid: false }), before);
  });

  test('a signed-in principal cannot reach the switch either', async () => {
    const client = agent(base);
    const login = await client.post('/v1/api/auth/login', {
      email: ctx.admin.email, password: 'test-password'
    });
    assert.equal(login.status, 200);

    const res = await client.post('/v1/api/demo/switch', { UserId: ctx.memberA.id });
    assert.equal(res.status, 404);
  });

  test('no sweeper is started, so no timer runs against a feature nobody uses', () => {
    assert.equal(demo.startSweeper(ctx.db), null);
  });

  test('an organization with no expiry is never expired', () => {
    /* The guard that keeps every real tenant out of the sweeper's query and
       out of tenant.js's refusal. */
    assert.equal(demo.hasExpired({ expires_at: null }), false);
    assert.equal(demo.hasExpired(null), false);
    assert.equal(demo.hasExpired({ expires_at: new Date(Date.now() + 1000) }), false);
    assert.equal(demo.hasExpired({ expires_at: new Date(Date.now() - 1000) }), true);
  });
});
