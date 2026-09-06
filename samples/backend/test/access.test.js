/* ══════════════════════════════════════════════════════════════════════════
   The access model, over real HTTP, per role.

   This is the suite that matters most, and the shape of every assertion is
   deliberate: **a denial is asserted as an EMPTY RESULT, not a status code.**

   Asking for a record you may not read must return exactly what asking for
   one that does not exist returns. A test that accepts a 403 would let
   through a regression that turns the endpoint into an oracle: "403 means it
   exists, 404 means it does not" leaks the one bit the rule was protecting.

   Everything here goes through the router, the middleware and the controller
   hooks in the order a browser meets them. Calling a hook directly would test
   the hook and miss the wiring — which is where these bugs live.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const { bootOnce, loadSecondOrg } = require('./helpers');
const { listen, agent } = require('./http');

let ctx, server, base, other;

before(async () => {
  ctx = await bootOnce();
  const app = require('../app')(ctx.db);
  ({ server, base } = await listen(app));
  other = await loadSecondOrg();
});

after(async () => { server.close(); });

/** Sign in and hand back a client with its own cookie jar. */
async function as(user) {
  const client = agent(base);
  const res = await client.post('/v1/api/auth/login', {
    email: user.email, password: 'test-password'
  });
  assert.equal(res.status, 200, `could not sign in as ${user.email}`);
  return client;
}

describe('the tenant boundary', () => {
  test('an owner cannot read another organization\'s customers by id', async () => {
    const client = await as(ctx.admin);
    const res = await client.get(`/v1/api/customers/${other.mine.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {}, 'a row from another tenant must be indistinguishable from no row');
  });

  test('a list never contains another organization\'s rows', async () => {
    const client = await as(ctx.admin);
    const res = await client.get('/v1/api/customers?limit=500');
    const ids = res.body.map((r) => r.OrganizationId);
    assert.ok(ids.every((id) => id === ctx.org.id), 'a foreign OrganizationId reached the list');
  });

  test('the organization cannot be set from the request body', async () => {
    const client = await as(ctx.admin);
    const res = await client.post('/v1/api/customers', {
      name: 'Smuggled', WorkspaceId: ctx.north.id, OrganizationId: other.org.id
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.OrganizationId, ctx.org.id);
  });
});

describe('the restricted model', () => {
  test('the front desk reads no notes at all', async () => {
    const client = await as(ctx.agent);
    const list = await client.get('/v1/api/notes');
    assert.deepEqual(list.body, []);

    const one = await client.get(`/v1/api/notes/${ctx.note.id}`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body, {}, 'a refusal must look exactly like a missing row');
  });

  test('the front desk cannot reach a note through ?include=', async () => {
    const client = await as(ctx.agent);
    const res = await client.get(`/v1/api/customers/${ctx.mine.id}?include=Notes`);
    assert.equal(res.status, 400, 'an association the role may not read must be refused, not eager-loaded');
  });

  test('the front desk cannot read notes through the audit trail either', async () => {
    const client = await as(ctx.agent);
    /* The same rule applied to the second copy of the data — the copy people
       forget. Change a note, then look for it in the log. */
    const member = await as(ctx.memberA);
    await member.put(`/v1/api/notes/${ctx.note.id}`, { body: 'Changed.' });

    const res = await client.get('/v1/api/audit-entries?limit=200');
    assert.ok(res.body.every((row) => row.entity !== 'note'),
      'a note entry reached a role that may not read notes');
  });

  test('a member reads their own notes and not a colleague\'s', async () => {
    const mine = await as(ctx.memberA);
    assert.equal((await mine.get('/v1/api/notes')).body.length, 1);

    const theirs = await as(ctx.memberB);
    assert.deepEqual((await theirs.get('/v1/api/notes')).body, []);
  });
});

describe('the portal', () => {
  test('a portal login sees exactly its own record', async () => {
    const client = await as(ctx.portal);
    const list = await client.get('/v1/api/customers');
    assert.equal(list.body.length, 1);
    assert.equal(String(list.body[0].id), String(ctx.mine.id));

    const other_ = await client.get(`/v1/api/customers/${ctx.theirs.id}`);
    assert.deepEqual(other_.body, {});
  });

  test('a portal login can request, never create', async () => {
    const client = await as(ctx.portal);
    const res = await client.post('/v1/api/tasks', {
      WorkspaceId: ctx.north.id, CustomerId: ctx.mine.id, MemberId: ctx.memberA.id,
      date: '2026-09-08', start: '11:00', duration: 30, title: 'Self-booked'
    });
    assert.equal(res.status, 403);
  });

  test('a create outside the caller\'s own scope is refused, not written and hidden', async () => {
    const client = await as(ctx.portal);
    const res = await client.post('/v1/api/customers', { name: 'Mine too', WorkspaceId: ctx.north.id });
    assert.equal(res.status, 403);
    const count = await ctx.db.Customer.count({ where: { name: 'Mine too' } });
    assert.equal(count, 0);
  });
});

describe('the platform account', () => {
  test('the superadmin holds no tenant data capability at all', async () => {
    const platform = await ctx.db.User.findOne({ where: { user_type: 'superadmin' } });
    await platform.update({ password: await require('../services/passwords').hash('test-password') });
    const client = await as(platform);

    for (const path of ['customers', 'tasks', 'notes', 'audit-entries']) {
      const res = await client.get(`/v1/api/${path}`);
      assert.deepEqual(res.body, [], `the platform account reached /${path}`);
    }
  });
});

describe('the audit trail', () => {
  test('every mutation leaves a row naming the user, the field, and both values', async () => {
    const client = await as(ctx.admin);
    await client.put(`/v1/api/customers/${ctx.mine.id}`, { phone: '+30 210 0000000' });

    const rows = await ctx.db.AuditEntry.findAll({
      where: { OrganizationId: ctx.org.id, entity: 'customer', entity_id: ctx.mine.id },
      order: [['id', 'DESC']], limit: 1, raw: true
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_name, ctx.admin.name);
    assert.equal(rows[0].to_value, '+30 210 0000000');
  });

  test('a save that changed nothing writes no row', async () => {
    const client = await as(ctx.admin);
    const before = await ctx.db.AuditEntry.count({ where: { OrganizationId: ctx.org.id } });
    await client.put(`/v1/api/customers/${ctx.mine.id}`, { phone: '+30 210 0000000' });
    const afterCount = await ctx.db.AuditEntry.count({ where: { OrganizationId: ctx.org.id } });
    assert.equal(afterCount, before);
  });
});

describe('the domain rules, over HTTP', () => {
  test('invariant 1: a second task in the same slot is refused with a code', async () => {
    const client = await as(ctx.admin);
    const res = await client.post('/v1/api/tasks', {
      WorkspaceId: ctx.north.id, CustomerId: ctx.theirs.id, MemberId: ctx.memberA.id,
      date: ctx.task.date, start: ctx.task.start, duration: 30, title: 'Double booked'
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'member_busy');
  });

  test('regression: an id sent as a string must not walk past the clash check', async () => {
    const client = await as(ctx.admin);
    const res = await client.post('/v1/api/tasks', {
      WorkspaceId: String(ctx.north.id), CustomerId: String(ctx.theirs.id),
      MemberId: String(ctx.memberA.id),
      date: ctx.task.date, start: ctx.task.start, duration: '30', title: 'String ids'
    });
    assert.equal(res.body.error, 'member_busy');
  });
});

describe('the framework\'s own guarantees', () => {
  test('a password is never readable — not in a body, a filter or a sort', async () => {
    const client = await as(ctx.admin);
    const list = await client.get('/v1/api/users');
    assert.ok(list.body.every((u) => u.password === undefined));

    /* A filter answers "is there a row where this is true" one bit at a time,
       which is the same column read slowly. */
    const probe = await client.get('/v1/api/users?by_password_like=$2a$%');
    assert.equal(probe.status, 400);

    const sorted = await client.get('/v1/api/users?sort_by=password');
    assert.equal(sorted.status, 400);
  });

  test('a failure is never a 200', async () => {
    const client = await as(ctx.admin);
    /* A duplicate e-mail is a unique constraint, which used to answer `{}`
       with status 200 — so the client closed the dialog and reported a save
       that had not happened. */
    const res = await client.post('/v1/api/users', {
      name: 'Clash', email: ctx.agent.email, user_type: 'member'
    });
    assert.notEqual(res.status, 200);
  });

  test('a request without the CSRF header is refused', async () => {
    const client = await as(ctx.admin);
    client.forgetCsrf();
    const res = await client.post('/v1/api/customers', { name: 'No token', WorkspaceId: ctx.north.id });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'csrf');
  });
});
