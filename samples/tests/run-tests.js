/* ══════════════════════════════════════════════════════════════════════════
   Frontend test runner — no dependencies, no framework.

   Run with:  node tests/run-tests.js      (or: npm test)

   The application modules are plain browser scripts that attach themselves to
   `window`. This runner points `window` at the Node global, supplies a
   minimal `document`, then evaluates every script in the same order
   frontend/app.html loads them. Two things follow:

     1. loading the files is itself a syntax check of the whole app, and
     2. every DOM-free module can be exercised directly.

   Sections — keep them grouped, and do not start a new one for a change that
   fits an existing one:

     A. every file parses and wires together
     B. U — dates, times, money, text
     C. Rules — the invariants, against fixtures small enough to read
     D. API — request shaping
     E. Store — the shapes the views read
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ── Minimal browser environment ───────────────────────────────────────── */

global.window = global;
global.document = {
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() { return { style: {}, appendChild() {}, remove() {}, setAttribute() {}, addEventListener() {} }; },
  body: { style: {}, appendChild() {} },
  documentElement: { setAttribute() {}, removeAttribute() {} }
};
global.location = { hash: '' };
global.matchMedia = () => ({ matches: false, addEventListener() {} });

/* The same order as frontend/app.html. Update this list when a view is added
   or removed — section A asserts every route resolves to a real view. */
const FILES = [
  'shared/utils.js',
  'frontend/js/dom.js',
  'shared/rules.js',
  'frontend/js/api.js',
  'frontend/js/store.js',
  'frontend/js/components.js',
  'frontend/js/views/login.js',
  'frontend/js/views/customers.js',
  'frontend/js/views/tasks.js',
  'frontend/js/views/audit.js',
  'frontend/js/app.js'
];

/* ── Tiny harness ──────────────────────────────────────────────────────── */

let passed = 0, failed = 0, group = '';
const failures = [];
const queue = [];

function describe(name, fn) { group = name; fn(); }

/**
 * Tests run in the order they are declared, one after another, whether or not
 * they return a promise.
 *
 * A test that is called and forgotten is fine for a synchronous assertion and
 * worthless for anything else: an `async` test returns a promise nobody holds,
 * its rejection goes nowhere, and it passes by never having been checked.
 */
function test(name, fn) { queue.push({ group, name, fn }); }

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((message || 'not equal') + `\n    expected ${b}\n    actual   ${a}`);
}

async function run() {
  for (const t of queue) {
    try {
      await t.fn();
      passed++;
    } catch (err) {
      failed++;
      failures.push({ ...t, err });
    }
  }
  failures.forEach((f) => console.log(`  ✗ ${f.group} — ${f.name}\n    ${f.err.message}`));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* ══ A. Load & wiring ═══════════════════════════════════════════════════ */

describe('A. load', () => {
  FILES.forEach((file) => {
    test(`${file} parses and evaluates`, () => {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      vm.runInThisContext(code, { filename: file });
    });
  });

  test('every route resolves to a real view', () => {
    Object.keys(App.ROUTES).forEach((name) => {
      const target = App.ROUTES[name].view;
      assert(global.Views && typeof Views[target] === 'object',
        `route ${name} points at Views.${target}, which does not exist`);
      assert(typeof Views[target].render === 'function',
        `Views.${target} has no render()`);
    });
  });

  test('no role is offered a route it lacks the capability for', () => {
    const caps = require(path.join(ROOT, 'backend/services/capabilities.js'));
    Object.keys(App.NAV).forEach((role) => {
      App.NAV[role].forEach((name) => {
        const route = App.ROUTES[name];
        assert(route, `NAV lists ${name} for ${role}, which is not a route`);
        if (!route.cap) return;
        assert(caps.can(role, route.cap),
          `${role} is offered ${name} but lacks ${route.cap}`);
      });
    });
  });

  test('every error code the API can return has a message', () => {
    ['member_busy', 'customer_busy', 'workspace_full', 'forbidden',
     'conflict', 'invalid', 'server_error'].forEach((code) => {
      assert(App.ERROR_TEXT[code], `no message for ${code}`);
    });
  });
});

/* ══ B. Utilities ═══════════════════════════════════════════════════════ */

describe('B. U', () => {
  test('dates stay strings and never touch a timezone', () => {
    equal(U.addDays('2026-02-28', 1), '2026-03-01');
    equal(U.addDays('2026-01-01', -1), '2025-12-31');
    equal(U.weekStart('2026-09-05'), '2026-08-31');   // Monday-first
    equal(U.daysBetween('2026-01-01', '2026-01-31'), 30);
  });

  test('time arithmetic happens in minutes', () => {
    equal(U.t2m('09:45'), 585);
    equal(U.m2t(585), '09:45');
    equal(U.m2t(U.t2m('23:30') + 45), '00:15');
  });

  test('adjacent slots do not overlap', () => {
    assert(!U.overlaps(600, 630, 630, 660), '10:00–10:30 must not clash with 10:30–11:00');
    assert(U.overlaps(600, 630, 615, 645));
  });

  test('esc escapes every character that could close a tag', () => {
    equal(U.esc('<img src=x onerror="y">'), '&lt;img src=x onerror=&quot;y&quot;&gt;');
  });

  test('money of an unknown value is said, not shown as NaN', () => {
    equal(U.money(undefined), '—');
    equal(U.money(12.5), '12.50 €');
  });
});

/* ══ C. Rules — the invariants ══════════════════════════════════════════ */

describe('C. Rules', () => {
  const base = {
    id: null, date: '2026-09-07', start: '10:00', duration: 30,
    MemberId: 7, CustomerId: 3, WorkspaceId: 1
  };
  const ctx = (tasks, capacity) => ({ tasks, capacity });

  test('invariant 1: one task per member per slot', () => {
    const clash = Rules.firstClash(base, ctx([
      { id: 9, date: '2026-09-07', start: '10:15', duration: 30, status: 'scheduled',
        MemberId: 7, CustomerId: 99, WorkspaceId: 1 }
    ]));
    equal(clash && clash.code, 'member_busy');
  });

  test('invariant 1: a string id must still find the clash (types on the wire)', () => {
    const clash = Rules.firstClash({ ...base, MemberId: '7' }, ctx([
      { id: 9, date: '2026-09-07', start: '10:00', duration: 30, status: 'scheduled',
        MemberId: 7, CustomerId: 99, WorkspaceId: 1 }
    ]));
    equal(clash && clash.code, 'member_busy');
  });

  test('invariant 3: a customer is never booked in two places at once', () => {
    const clash = Rules.firstClash(base, ctx([
      { id: 9, date: '2026-09-07', start: '10:00', duration: 30, status: 'scheduled',
        MemberId: 8, CustomerId: 3, WorkspaceId: 2 }
    ]));
    equal(clash && clash.code, 'customer_busy');
  });

  test('invariant 2: a workspace refuses more than its capacity', () => {
    const others = [1, 2].map((n) => ({
      id: n, date: '2026-09-07', start: '10:00', duration: 30, status: 'scheduled',
      MemberId: 20 + n, CustomerId: 100 + n, WorkspaceId: 1
    }));
    equal(Rules.firstClash(base, ctx(others, { 1: 2 })).code, 'workspace_full');
    assert(Rules.canBook(base, ctx(others, { 1: 3 })), 'capacity 3 must accept a third');
  });

  test('a cancelled task frees its slot', () => {
    const clash = Rules.firstClash(base, ctx([
      { id: 9, date: '2026-09-07', start: '10:00', duration: 30, status: 'cancelled',
        MemberId: 7, CustomerId: 99, WorkspaceId: 1 }
    ]));
    equal(clash, null);
  });

  test('invariant 4: start times run on the grid and durations are a closed list', () => {
    equal(Rules.firstClash({ ...base, start: '10:07' }, ctx([])).code, 'off_grid');
    equal(Rules.firstClash({ ...base, duration: 37 }, ctx([])).code, 'bad_duration');
  });
});

/* ══ D. API — request shaping ═══════════════════════════════════════════ */

describe('D. API', () => {
  test('query drops empty values and encodes the rest', () => {
    equal(API.query({ a: 1, b: '', c: null, d: 'x y' }), '?a=1&d=x%20y');
    equal(API.query({ id: [1, 2] }), '?id=1&id=2');
  });
});

/* ══ E. Store — the shapes the views read ═══════════════════════════════
   Store is driven through a stand-in for the API: `API.get` and `API.post` are
   replaced for the length of one test and answer with the INTEGERS Sequelize
   really sends. That reaches the parts a fixture cannot — the mapping layer,
   the scope checks, what a write leaves behind — without a server.

   Restore the real functions in a `finally`. Tests run in declaration order,
   and the next one will use whatever was left.
   ═══════════════════════════════════════════════════════════════════════ */

describe('E. Store', () => {
  function stub(answers) {
    const realGet = API.get, realPost = API.post, realPut = API.put;
    API.get = (path) => Promise.resolve({ ok: true, status: 200, data: answers[path.split('?')[0]] ?? [] });
    API.post = () => Promise.resolve({ ok: true, status: 200, data: { id: 1 } });
    API.put = () => Promise.resolve({ ok: true, status: 200, data: { updated: 1 } });
    return () => { API.get = realGet; API.post = realPost; API.put = realPut; };
  }

  test('boot maps the principal, the capabilities and the reference data', async () => {
    const restore = stub({
      '/auth/me': { user: { id: 5, name: 'Ada', user_type: 'admin', OrganizationId: 2, capabilities: ['customer.create'] } },
      '/workspaces': [{ id: 1, code: 'HQ', name: 'Head office' }],
      '/users': [{ id: 5, name: 'Ada', user_type: 'admin', all_workspaces: true }]
    });
    try {
      await Store.boot();
      equal(Store.currentUser().name, 'Ada');
      assert(Store.can('customer.create'));
      /* Ids are STRINGS on this side of the wire. */
      equal(Store.workspaces()[0].id, '1');
      equal(Store.workspaceName(1), 'Head office');
    } finally { restore(); }
  });

  test('an unknown id is said, not rendered as the word undefined', async () => {
    equal(Store.userName(9999), '—');
    equal(Store.workspaceName(null), '—');
  });

  test('a list figure comes from the server, not from an unloaded collection', async () => {
    const restore = stub({ '/customers': [{ id: 3, WorkspaceId: 1, MemberId: 5, name: 'Blue Ltd', status: 'active', open_tasks: 4 }] });
    try {
      await Store.load({ customers: {} });
      equal(Store.customers()[0].openTasks, 4);
      equal(Store.customers()[0].id, '3');
    } finally { restore(); }
  });
});

run();
