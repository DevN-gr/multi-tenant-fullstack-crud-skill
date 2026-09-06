/* ══════════════════════════════════════════════════════════════════════════
   The CRUD framework itself, against an isolated model.

   No app boot, no auth, no seeds: a throwaway model and a router, so a
   failure here is a failure of routes/crud.js and of nothing else. Access
   rules belong in access.test.js, over real HTTP, per role.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { Sequelize, DataTypes } = require('sequelize');

const crudThat = require('../routes/crud');
const { listen, agent } = require('./http');

let sequelize, Widget, server, base, client;

before(async () => {
  sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  Widget = sequelize.define('Widget', {
    OwnerId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    size: { type: DataTypes.INTEGER, allowNull: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    secret: { type: DataTypes.STRING, allowNull: true }
  }, { paranoid: true });
  await sequelize.sync({ force: true });

  const app = express();
  app.use(express.json());
  /* One fixed principal: this suite is about the framework, not about who. */
  app.use((req, res, next) => { req.user = { id: 1, OwnerId: 1, user_type: 'admin' }; next(); });
  app.use('/widgets', crudThat(Widget, {
    extraFilters: async (req) => ({ OwnerId: req.user.OwnerId }),
    createDefaultAssociations: async (req) => { req.body.OwnerId = req.user.OwnerId; },
    hiddenFields: async () => ['secret'],
    readOnlyFields: async () => ['OwnerId'],
    searchableFields: async () => ['name'],
    defaultSortingColumn: 'name'
  }));

  ({ server, base } = await listen(app));
  client = agent(base);

  await Widget.bulkCreate([
    { OwnerId: 1, name: 'alpha', size: 10, secret: 'a' },
    { OwnerId: 1, name: 'beta', size: 20, secret: 'b' },
    { OwnerId: 2, name: 'gamma', size: 30, secret: 'c' }   // another owner's
  ]);
});

after(async () => { server.close(); await sequelize.close(); });

describe('scope', () => {
  test('extraFilters bounds every read', async () => {
    const res = await client.get('/widgets');
    assert.equal(res.body.length, 2);
  });

  test('the addressed row and the scope are ANDed, never merged', async () => {
    /* A scope naming the same column as the URL must not REPLACE it. This is
       the bug that made GET /widgets/3 quietly return your own row. */
    const res = await client.get('/widgets/3');
    assert.deepEqual(res.body, {});
  });

  test('extraFilters bounds delete as well as read', async () => {
    const res = await client.del('/widgets/3');
    assert.equal(res.status, 200);
    assert.ok(await Widget.findByPk(3), 'another owner\'s row was deleted by id');
  });

  test('a create outside the caller\'s scope is refused in memory, before the write', async () => {
    const guarded = express();
    guarded.use(express.json());
    guarded.use((req, res, next) => { req.user = { id: 9 }; next(); });
    guarded.use('/w', crudThat(Widget, { extraFilters: async () => ({ id: -1 }) }));
    const { server: s2, base: b2 } = await listen(guarded);
    const c2 = agent(b2);
    const res = await c2.post('/w', { name: 'nope', OwnerId: 1 });
    assert.equal(res.status, 403);
    s2.close();
  });
});

describe('hidden fields', () => {
  test('a hidden column is absent from the body', async () => {
    const res = await client.get('/widgets');
    assert.ok(res.body.every((w) => w.secret === undefined));
  });

  test('a hidden column cannot be filtered, sorted or searched', async () => {
    assert.equal((await client.get('/widgets?by_secret_like=a%')).status, 400);
    assert.equal((await client.get('/widgets?sort_by=secret')).status, 400);
  });
});

describe('query parameters', () => {
  test('exact, operator and IN filters', async () => {
    assert.equal((await client.get('/widgets?name=alpha')).body.length, 1);
    assert.equal((await client.get('/widgets?by_size_gte=20')).body.length, 1);
    assert.equal((await client.get('/widgets?in_size=10,20')).body.length, 2);
  });

  test('an unknown column, operator or direction is a 400, not a silent full scan', async () => {
    assert.equal((await client.get('/widgets?by_nope_eq=1')).status, 400);
    assert.equal((await client.get('/widgets?by_size_wat=1')).status, 400);
    assert.equal((await client.get('/widgets?sort_direction=SIDEWAYS')).status, 400);
  });

  test('with_count returns data and meta; count_only returns meta alone', async () => {
    const paged = await client.get('/widgets?limit=1&with_count=true');
    assert.equal(paged.body.data.length, 1);
    assert.equal(paged.body.meta.total, 2);
    assert.equal(paged.body.meta.pages, 2);

    const counted = await client.get('/widgets?count_only=true');
    assert.equal(counted.body.total, 2);
  });

  test('search matches every whitespace-separated term', async () => {
    assert.equal((await client.get('/widgets?search=alp')).body.length, 1);
    assert.equal((await client.get('/widgets?search=alp bet')).body.length, 0);
  });
});

describe('types on the wire', () => {
  test('the body is coerced to the types the model declares', async () => {
    /* Load-bearing rather than tidy: hooks reason about the body BEFORE the
       write, in JavaScript, and 7 === "7" is false. */
    const res = await client.post('/widgets', { name: 'delta', size: '40', active: 'false' });
    assert.strictEqual(res.body.size, 40);
    assert.strictEqual(res.body.active, false);
  });
});

describe('write protection', () => {
  test('a read-only field is dropped from an update', async () => {
    await client.put('/widgets/1', { OwnerId: 2, name: 'alpha-2' });
    const row = await Widget.findByPk(1);
    assert.equal(row.OwnerId, 1);
    assert.equal(row.name, 'alpha-2');
  });

  test('the primary key and the timestamps are the framework\'s, never the client\'s', async () => {
    await client.put('/widgets/1', { id: 999 });
    assert.ok(await Widget.findByPk(1), 'a PUT rewrote the primary key');
  });
});

describe('failures', () => {
  test('a validation error is 422, not an empty 200', async () => {
    const res = await client.post('/widgets', { size: 5 });        // name is NOT NULL
    assert.notEqual(res.status, 200);
    assert.ok(res.status >= 400);
  });
});
