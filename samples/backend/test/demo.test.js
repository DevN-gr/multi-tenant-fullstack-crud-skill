/* ══════════════════════════════════════════════════════════════════════════
   The demo tenant, over real HTTP.

   Three things are being proved, and only the first is about the demo:

     1. The door does what services/demo.js says it does — it provisions, it
        meters, and it hands back a working session.
     2. A demo tenant is an ORDINARY tenant. The boundary that keeps two
        customers apart keeps a demo away from real data, without one line
        anywhere saying "if demo".
     3. "Deleted after a day" is true in the only sense that matters: the
        rows are gone, not flagged. Every model here is `paranoid`, so the
        assertions below read with `paranoid: false` — a purge that forgot
        `force: true` passes every count that does not.

   This file sets its own NODE_CONFIG before anything reads the configuration,
   which is how it gets a demo switched ON and a ceiling low enough to reach.
   node:test gives each file its own process, so that setting belongs to this
   suite alone.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

process.env.NODE_ENV = 'test';
process.env.NODE_CONFIG = JSON.stringify({
  log_level: 'silent',
  demo: { enabled: true, ttl_hours: 24, max_live: 2, per_ip_minutes: 0, sweep_minutes: 15 }
});

const { test, before, beforeEach, after, describe } = require('node:test');
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

/* The ceiling in this file is two, which is what makes it reachable — so
   every test starts from an empty one rather than from whatever the test
   before it left running. A suite whose assertions depend on the order they
   are declared in is a suite that fails when somebody inserts a case. */
beforeEach(async () => { if (ctx) await clearDemos(); });

/** A visitor who has just pressed the button on the landing page. */
async function visitor() {
  const client = agent(base);
  const res = await client.post('/v1/api/demo');
  assert.equal(res.status, 200, `the demo door answered ${res.status}`);
  return { client, user: res.body.user };
}

/** Sign in the ordinary way, for the assertions about real tenants. */
async function as(user) {
  const client = agent(base);
  const res = await client.post('/v1/api/auth/login', {
    email: user.email, password: 'test-password'
  });
  assert.equal(res.status, 200, `could not sign in as ${user.email}`);
  return client;
}

/** Expire every demo and sweep it away, so a test starts from a known floor. */
async function clearDemos() {
  await ctx.db.Organization.update(
    { expires_at: new Date(Date.now() - 60000) },
    { where: { is_demo: true }, paranoid: false }
  );
  await demo.sweep(ctx.db);
}

/* ══ The policy, on its own ════════════════════════════════════════════════
   Pure, so every branch is asserted here rather than by manufacturing the
   state over HTTP. The suites below only have to prove the route asks it.
   ════════════════════════════════════════════════════════════════════════ */

describe('who gets a demo', () => {
  const ON = { enabled: true, ttlHours: 24, maxLive: 3, perIpMinutes: 10, sweepMinutes: 15 };

  test('nobody, when the feature is off', () => {
    assert.equal(demo.refusalFor({ liveCount: 0, msSinceIpLast: null }, { ...ON, enabled: false }),
      'demo_disabled');
  });

  test('an address that asked a minute ago is asked to wait', () => {
    assert.equal(demo.refusalFor({ liveCount: 0, msSinceIpLast: 60 * 1000 }, ON), 'demo_cooldown');
  });

  test('the same address an hour later is not', () => {
    assert.equal(demo.refusalFor({ liveCount: 0, msSinceIpLast: 3600 * 1000 }, ON), null);
  });

  test('a zero cooldown switches the speed bump off entirely', () => {
    assert.equal(demo.refusalFor({ liveCount: 0, msSinceIpLast: 1 }, { ...ON, perIpMinutes: 0 }), null);
  });

  test('the ceiling refuses when it is reached, not after it is passed', () => {
    assert.equal(demo.refusalFor({ liveCount: 2, msSinceIpLast: null }, ON), null);
    assert.equal(demo.refusalFor({ liveCount: 3, msSinceIpLast: null }, ON), 'demo_unavailable');
  });

  test('somebody holding a demo is told that, not that the site is full', () => {
    /* Both conditions true at once. The cooldown is the more useful answer:
       they have one open, and can be pointed at it. */
    assert.equal(demo.refusalFor({ liveCount: 9, msSinceIpLast: 1000 }, ON), 'demo_cooldown');
  });
});

/* ══ The door ═════════════════════════════════════════════════════════════ */

describe('pressing the button', () => {
  test('provisions a tenant and signs the visitor in as its owner', async () => {
    const { user } = await visitor();

    assert.equal(user.user_type, 'admin');
    assert.ok(user.OrganizationId, 'the principal carries no tenant');
    assert.ok(user.demo, 'the principal does not say it is a demo');

    const hours = (new Date(user.demo.expires_at) - Date.now()) / 3600000;
    assert.ok(hours > 23 && hours <= 24, `expires in ${hours} hours`);

    /* The cast is what the switcher in the banner is built from. Sent with
       the principal because a member cannot list an owner. */
    assert.deepEqual(
      user.demo.cast.map((m) => m.user_type).sort(),
      ['admin', 'agent', 'customer', 'member', 'member']
    );
  });

  test('the tenant arrives with work on both sides of today', async () => {
    const { client } = await visitor();

    const customers = await client.get('/v1/api/customers?limit=100');
    assert.equal(customers.status, 200);
    assert.equal(customers.body.length, 8);

    const tasks = await client.get('/v1/api/tasks?limit=200');
    const dates = tasks.body.map((t) => t.date).sort();
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(dates[0] < today, 'nothing in the past — half the screens are empty');
    assert.ok(dates[dates.length - 1] > today, 'nothing in the future — the diary is empty');
  });

  test('the seeded work obeys the product\'s own rules', async () => {
    /* These rows go in through Sequelize rather than through the controllers,
       so nothing checked them on the way. A demo whose diary shows a member
       booked twice at ten o'clock argues against the product it is there to
       sell — and the rule that would have caught it is right here, shared
       with the browser. */
    const { Rules } = require('../shared');
    const { client } = await visitor();
    const tasks = (await client.get('/v1/api/tasks?limit=500')).body;

    const ctx = { tasks };
    const broken = tasks.map((t) => Rules.firstClash(t, ctx)).filter(Boolean);
    assert.deepEqual(broken, [], `the demo seeded ${broken.length} illegal rows`);
  });

  test('a demo account cannot be signed into with a password', async () => {
    /* It has no stored hash at all, so there is nothing to guess. This is
       what makes the demo door the ONLY way into a demo tenant. */
    const { client } = await visitor();
    const me = await client.get('/v1/api/auth/me');

    const attempt = await agent(base).post('/v1/api/auth/login', {
      email: me.body.user.email, password: ''
    });
    assert.equal(attempt.status, 401);
  });

  test('the address that asked is not readable by the tenant it created', async () => {
    const { client } = await visitor();
    const res = await client.get('/v1/api/organizations');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].created_ip, undefined,
      'a visitor IP address reached a tenant that should not see it');
  });
});

/* ══ It is an ordinary tenant ═════════════════════════════════════════════ */

describe('the tenant boundary', () => {
  test('a demo cannot read a real tenant\'s rows', async () => {
    const { client } = await visitor();

    const byId = await client.get(`/v1/api/customers/${ctx.mine.id}`);
    assert.equal(byId.status, 200);
    assert.deepEqual(byId.body, {}, 'a real customer was visible inside a demo');

    const list = await client.get('/v1/api/customers?limit=500');
    assert.ok(list.body.every((row) => row.OrganizationId !== ctx.org.id));
  });

  test('a real tenant cannot read the demo\'s rows', async () => {
    const { client } = await visitor();
    const demoCustomer = (await client.get('/v1/api/customers?limit=1')).body[0];

    const owner = await as(ctx.admin);
    const res = await owner.get(`/v1/api/customers/${demoCustomer.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {});
  });
});

/* ══ The cast ═════════════════════════════════════════════════════════════ */

describe('becoming somebody else', () => {
  test('a member sees less than the owner, and can get back', async () => {
    const { client, user } = await visitor();
    const asOwner = (await client.get('/v1/api/customers?limit=100')).body.length;

    const member = user.demo.cast.find((m) => m.user_type === 'member');
    const switched = await client.post('/v1/api/demo/switch', { UserId: member.id });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.user.user_type, 'member');

    const asMember = (await client.get('/v1/api/customers?limit=100')).body.length;
    assert.ok(asMember < asOwner, `a member saw ${asMember} of ${asOwner} customers`);

    /* The way back. The cast travels with every principal, so the narrower
       role still knows who the owner is. */
    const owner = switched.body.user.demo.cast.find((m) => m.user_type === 'admin');
    const back = await client.post('/v1/api/demo/switch', { UserId: owner.id });
    assert.equal(back.status, 200);
    assert.equal((await client.get('/v1/api/customers?limit=100')).body.length, asOwner);
  });

  test('the narrowest role in the product works too', async () => {
    /* The portal login resolves through middleware/tenant.js to the customer
       record behind it, and a demo user with no such record would be refused
       everything. Worth asserting because it is the one role whose session
       needs a row seeded specially for it. */
    const { client, user } = await visitor();
    const portal = user.demo.cast.find((m) => m.user_type === 'customer');

    const switched = await client.post('/v1/api/demo/switch', { UserId: portal.id });
    assert.equal(switched.status, 200);

    const tasks = await client.get('/v1/api/tasks?limit=100');
    assert.equal(tasks.status, 200, 'a portal login in a demo was refused its own screens');
    assert.ok(tasks.body.length > 0, 'the portal customer has nothing to look at');
  });

  test('a real session cannot switch at all', async () => {
    const owner = await as(ctx.admin);
    const res = await owner.post('/v1/api/demo/switch', { UserId: ctx.memberA.id });
    assert.equal(res.status, 403, 'the demo switch became an impersonation endpoint');
  });

  test('a demo session cannot switch into another tenant', async () => {
    const { client } = await visitor();
    const res = await client.post('/v1/api/demo/switch', { UserId: ctx.admin.id });
    assert.equal(res.status, 404, 'a demo reached an account outside its own tenant');

    /* And is still who it was. */
    const me = await client.get('/v1/api/auth/me');
    assert.notEqual(me.body.user.id, ctx.admin.id);
  });

  test('an anonymous caller cannot switch', async () => {
    const res = await agent(base).post('/v1/api/demo/switch', { UserId: 1 });
    assert.equal(res.status, 401);
  });

  test('a malformed target is refused rather than crashing the handler', async () => {
    const { client } = await visitor();
    const res = await client.post('/v1/api/demo/switch', { UserId: 'not-an-id' });
    assert.equal(res.status, 404);
  });
});

/* ══ Expiry, and the broom ════════════════════════════════════════════════ */

describe('when the day runs out', () => {
  test('the tenant stops answering before anything has swept it', async () => {
    const { client, user } = await visitor();

    await ctx.db.Organization.update(
      { expires_at: new Date(Date.now() - 1000) },
      { where: { id: user.OrganizationId } }
    );

    const res = await client.get('/v1/api/customers');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'demo_expired',
      'an expired demo kept serving until a timer happened to run');
  });

  test('the sweep deletes every row, and deletes them for real', async () => {
    const { user } = await visitor();
    const orgId = user.OrganizationId;

    const counts = async () => {
      const out = {};
      for (const name of demo.PURGE_ORDER) {
        /* paranoid:false is the whole assertion: a soft delete leaves every
           one of these rows in place with a deletedAt, and "deleted after a
           day" would be a sentence that is false. */
        out[name] = await ctx.db[name].count({ where: { OrganizationId: orgId }, paranoid: false });
      }
      return out;
    };

    const before = await counts();
    assert.ok(Object.values(before).every((n) => n > 0), `nothing was seeded: ${JSON.stringify(before)}`);

    await ctx.db.Organization.update(
      { expires_at: new Date(Date.now() - 1000) }, { where: { id: orgId } }
    );
    await demo.sweep(ctx.db);

    const after = await counts();
    assert.deepEqual(after, Object.fromEntries(demo.PURGE_ORDER.map((n) => [n, 0])));
    assert.equal(await ctx.db.Organization.count({ where: { id: orgId }, paranoid: false }), 0);
  });

  test('a demo that was soft-deleted through the API is still swept', async () => {
    /* An Organization is paranoid, so a `destroy` hides the tenant and leaves
       every child row behind. Read with the default scope, the sweeper would
       never see it again and those rows would live for ever. */
    const { user } = await visitor();
    const orgId = user.OrganizationId;

    await ctx.db.Organization.update(
      { expires_at: new Date(Date.now() - 1000) }, { where: { id: orgId } }
    );
    await ctx.db.Organization.destroy({ where: { id: orgId } });   // soft

    await demo.sweep(ctx.db);

    assert.equal(await ctx.db.Customer.count({ where: { OrganizationId: orgId }, paranoid: false }), 0);
    assert.equal(await ctx.db.Organization.count({ where: { id: orgId }, paranoid: false }), 0);
  });

  test('the sessions of a deleted tenant go with it', async () => {
    const { client, user } = await visitor();
    const orgId = user.OrganizationId;

    const tokens = await ctx.db.AuthToken.count({ where: { UserId: user.id } });
    assert.ok(tokens > 0, 'the demo session minted no refresh token');

    await ctx.db.Organization.update(
      { expires_at: new Date(Date.now() - 1000) }, { where: { id: orgId } }
    );
    await demo.sweep(ctx.db);

    assert.equal(await ctx.db.AuthToken.count({ where: { UserId: user.id } }), 0);

    /* And the browser holding that session is simply anonymous again. */
    const res = await client.get('/v1/api/auth/me');
    assert.equal(res.status, 401);
  });
});

/* ══ The ceiling ══════════════════════════════════════════════════════════ */

describe('the ceiling', () => {
  test('fills, refuses with Retry-After, and opens again after a sweep', async () => {
    await clearDemos();                       // a known floor, whatever ran before

    const max = demo.settings().maxLive;
    for (let i = 0; i < max; i += 1) await visitor();

    const refused = await agent(base).post('/v1/api/demo');
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, 'demo_unavailable');
    assert.ok(Number(refused.headers.get('retry-after')) > 0,
      'a 429 with no Retry-After tells a client to guess');

    await clearDemos();
    const after = await agent(base).post('/v1/api/demo');
    assert.equal(after.status, 200);
  });
});
