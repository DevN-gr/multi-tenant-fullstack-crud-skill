/* ══════════════════════════════════════════════════════════════════════════
   Indices, asserted generically.

   One rule, enforced for every mounted resource: **a controller's
   defaultSortingColumn must be a contiguous run at either end of some index
   on its model.** At the front, the index IS the order; at the back, the
   columns in front of it are the scope the query filters on.

   Change a default sort and this fails until an index moves with it, because
   a sort with nothing behind it is a filesort over the whole tenant —
   invisible on a seeded demo, expensive on real data.

   Also asserted: every environment with a database entry has a config file,
   and every resource in app.js's RESOURCES table names a model and a
   controller that exist. Those two are cheap and catch a whole class of
   "works on my machine".
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { test, before, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { boot } = require('./helpers');
const { RESOURCES } = require('../app');

let db, controllers;

before(async () => {
  db = await boot();
  controllers = require('../controllers')(db);
});

describe('the mount table', () => {
  test('every resource names a model and a controller that exist', () => {
    RESOURCES.forEach(({ path: p, model, controller }) => {
      assert.ok(db[model], `${p} names model ${model}, which does not exist`);
      assert.ok(controllers[controller], `${p} names controller ${controller}, which does not exist`);
    });
  });

  test('every tenant-scoped model carries an OrganizationId column', () => {
    db.TENANT_SCOPED.forEach((name) => {
      assert.ok(db[name].rawAttributes.OrganizationId,
        `${name} is listed as tenant-scoped and has no OrganizationId`);
    });
  });
});

describe('sorting has an index behind it', () => {
  test('every defaultSortingColumn is a contiguous run at one end of an index', () => {
    RESOURCES.forEach(({ path: p, model, controller }) => {
      const sort = [].concat(controllers[controller].defaultSortingColumn || 'id');
      if (sort.length === 1 && sort[0] === 'id') return;         // the PK is indexed

      const indexes = (db[model].options.indexes || [])
        .map((i) => i.fields.map((f) => (typeof f === 'string' ? f : f.name)));

      const covered = indexes.some((fields) => {
        const head = fields.slice(0, sort.length).join(',') === sort.join(',');
        const tail = fields.slice(-sort.length).join(',') === sort.join(',');
        return head || tail;
      });

      assert.ok(covered,
        `${p} sorts by [${sort}] with no index that starts or ends with it`);
    });
  });
});

describe('environments', () => {
  test('every environment with a database entry has a config file', () => {
    const dir = path.join(__dirname, '..', 'config');
    ['development', 'test', 'qa', 'production'].forEach((env) => {
      assert.ok(fs.existsSync(path.join(dir, `${env}.json`)),
        `NODE_ENV=${env} has a database entry and no config/${env}.json — ` +
        'it would silently run on default.json');
    });
  });
});
