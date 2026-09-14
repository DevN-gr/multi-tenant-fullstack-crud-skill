/* ══════════════════════════════════════════════════════════════════════════
   Browser smoke test.

   run-tests.js proves the rules; backend/test proves the API; this proves the
   app actually renders and that the two halves fit together — including the
   landing page, which is the first thing a stranger sees and carries the one
   button in this product pressed by people who have never signed in.

   It drives a real Chrome through a real sign-in and every route for every
   role — and fails on ANY console error, uncaught exception or failed
   request. That is what
   catches the class of bug neither unit suite sees: a typo in a template
   string, a null deref inside a view, a field the API renamed and a view
   still asks for.

   **A form or an upload is not finished until this file has driven it.** Not
   the endpoint behind it, and not the function that builds the request — the
   control itself, clicked and typed into, against a running stack. The rule
   is paid for: an upload route declared PUT on the server and sent as POST by
   the browser answered 404 for every file, while both unit suites passed —
   one called the endpoint correctly, the other never issued the request at
   all. From inside the browser, a route that does not exist and a route that
   refuses look identical.

   The whole stack runs in this process: the API on an in-memory database, the
   static server proxying to it, and Chrome pointed at that. Nothing external
   is needed and nothing is left behind.

   Run with:  node tools/smoke.js         (or: npm run smoke)
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

process.env.NODE_ENV = 'test';
/* The demo is off by default, and this suite drives the button that needs it
   on. `per_ip_minutes: 0` because every request in this process comes from
   127.0.0.1, so the speed bump would refuse the second one — and the second
   one is the interesting one: it is pressed while a session is already open.
   The policy itself is asserted in backend/test/demo.test.js. */
process.env.NODE_CONFIG = JSON.stringify({
  log_level: 'silent',
  demo: { enabled: true, ttl_hours: 24, max_live: 10, per_ip_minutes: 0, sweep_minutes: 15 }
});

const http = require('http');
const { once } = require('events');
const puppeteer = require('puppeteer');

const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m';

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ${GREEN}✓${RESET} ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ${RED}✗${RESET} ${name}${detail ? DIM + ' — ' + detail + RESET : ''}`); }
}

/** The password every seeded account is given, so the suite can be them. */
const PW = 'smoke-test-password';

(async () => {
  /* ── The stack ────────────────────────────────────────────────────── */

  const db = require('../backend/models');
  await db.init();

  const { seedOrganization } = require('../backend/test/helpers');
  const passwords = require('../backend/services/passwords');
  const seeded = await seedOrganization('Smoke Ltd');

  for (const user of [seeded.admin, seeded.agent, seeded.memberA, seeded.portal]) {
    await user.update({ password: await passwords.hash(PW), status: 'active' });
  }

  const api = http.createServer(require('../backend/app')(db));
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  process.env.API_ORIGIN = `http://127.0.0.1:${api.address().port}`;

  const { start } = require('./server');
  /* Port 0: the OS picks a free one. A fixed port is held by the static
     server of a run that crashed before its cleanup, and the next run then
     fails with EADDRINUSE — a failure that names the port rather than the
     bug, on a suite whose whole job is to name the bug. */
  const { server } = await start(0);
  const url = `http://127.0.0.1:${server.address().port}`;

  /* The bare URL, before Chrome opens.

     `/` is the landing page and `/app.html` is the application, and BOTH are
     asked for here because `/` is precisely what both containers'
     HEALTHCHECK fetches. It was once mapped to a file this app does not
     have, so it answered 404 while every real request kept working: a web
     container reported unhealthy for ever, and a deploy that waits on health
     reading that as a failed release and rolling back. */
  const status = (at) => new Promise((done) => {
    http.get(at, (r) => { r.resume(); done(r.statusCode); }).on('error', () => done(0));
  });

  const rootStatus = await status(`${url}/`);
  check('GET / serves the landing page — the URL the healthcheck probes',
        rootStatus === 200, `status ${rootStatus}`);

  const appStatus = await status(`${url}/app.html`);
  check('GET /app.html still serves the application shell',
        appStatus === 200, `status ${appStatus}`);

  /* ── Chrome ───────────────────────────────────────────────────────── */

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  /* Any console error, uncaught exception or failed request fails the run.
     Keep the console clean rather than filtering the assertion. */
  let noise = [];
  let forgiving = false;
  page.on('console', (m) => { if (m.type() === 'error' && !forgiving) noise.push(m.text()); });
  page.on('pageerror', (e) => { if (!forgiving) noise.push(String(e)); });
  page.on('requestfailed', (r) => { if (!forgiving) noise.push(`${r.method()} ${r.url()}`); });

  /** Forgive exactly the noise one deliberate failure produces, and nothing
      else. Do not widen this. */
  async function expectingFailure(fn) {
    const earlier = noise.slice();   // anything already wrong stays wrong
    forgiving = true;
    try { return await fn(); } finally { forgiving = false; noise = earlier; }
  }

  /**
   * Wait for a completed paint.
   *
   * Rendering is asynchronous, so "a page with no skeleton" is the wrong
   * condition — the PREVIOUS screen satisfies it too. app.js bumps
   * data-render-seq after each paint; wait for it to move.
   */
  async function settledAfter(before) {
    await page.waitForFunction(
      (n) => Number(document.documentElement.getAttribute('data-render-seq') || 0) > n,
      { timeout: 15000 }, before
    );
  }
  const seq = () => page.evaluate(() =>
    Number(document.documentElement.getAttribute('data-render-seq') || 0));

  /**
   * Wait until the browser is on `target`, whatever gets it there.
   *
   * Not `waitForNavigation`: that resolves — or rejects into a `catch` — on
   * its own schedule, and an assertion made the instant it returns can run
   * before the request that causes the navigation has even been answered.
   * That reads as "the redirect never happened" when the truth is "not yet".
   *
   * Polled from out here rather than inside the page, because the thing being
   * waited for REPLACES the document, which destroys any execution context a
   * `waitForFunction` would be polling in.
   */
  async function waitForPath(target, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const where = await page.evaluate(() => location.pathname).catch(() => null);
      if (where === target) return true;
      await new Promise((done) => setTimeout(done, 250));
    }
    return false;
  }

  /**
   * Go to a route and wait for the paint it causes — if it causes one.
   *
   * Assigning the hash the browser is ALREADY on fires no hashchange, so
   * nothing re-renders and there is no paint to wait for. Waiting anyway
   * hangs until the timeout, and the screen it was waiting for is on the
   * display the whole time. Every role hits this on its first route:
   * signing in has already landed there.
   */
  async function goToRoute(route) {
    const before = await seq();
    const moved = await page.evaluate((r) => {
      const target = '#/' + r;
      if (location.hash === target) return false;
      location.hash = target;
      return true;
    }, route);
    if (moved) await settledAfter(before);
  }

  /**
   * The sign-in screen, with nothing behind it, whatever came before.
   *
   * Two things have to be undone, and neither is visible on its own:
   *
   *   • the session cookie, which outlives a navigation. Still set, the app
   *     renders the previous role's screens and there is no form to fill in.
   *   • the document — because /app.html#/login from /app.html#/audit is a
   *     SAME-DOCUMENT navigation. Nothing reloads, so the previous role's
   *     Store is still in memory with the previous role's user in it, and
   *     the app draws that user over a session that no longer exists.
   *
   * There IS a sign-out control, and it is clicked in its own step below —
   * but this reset has to work from any state, including the first call,
   * when nobody is signed in and there is no nav to click. So it does what
   * no control can: it arrives as a stranger.
   */
  async function openSignIn() {
    const cdp = await page.createCDPSession();
    await cdp.send('Network.clearBrowserCookies');
    await cdp.detach();
    await page.goto('about:blank');
    await page.goto(`${url}/app.html#/login`, { waitUntil: 'networkidle0' });
  }

  async function signIn(email) {
    /* An anonymous tab boots by asking whether it has a session: /auth/me
       answers 401, the one silent retry asks /auth/refresh and that answers
       401 too, and Chrome logs both as console errors. That is the correct
       answer to "am I signed in?" when nobody is, so it is forgiven here —
       and only here. */
    await expectingFailure(() => openSignIn());
    await page.type('input[name=email]', email);
    await page.type('input[name=password]', PW);
    const before = await seq();
    await page.click('button[type=submit]');
    await settledAfter(before);
  }

  /* ── Every route, for every role ──────────────────────────────────── */

  const ROLES = [
    { who: seeded.admin, routes: ['customers', 'tasks', 'audit'] },
    { who: seeded.agent, routes: ['customers', 'tasks', 'audit'] },
    { who: seeded.memberA, routes: ['customers', 'tasks'] },
    { who: seeded.portal, routes: ['tasks'] }
  ];

  for (const { who, routes } of ROLES) {
    console.log(`\n${who.user_type}`);
    await signIn(who.email);

    for (const route of routes) {
      await goToRoute(route);

      const text = await page.evaluate(() => document.body.innerText);
      /* Not a formatting rule. Each of these is a key missing from a Store
         answer, and the screen renders perfectly while saying nothing true. */
      check(`${route} renders without undefined/NaN/[object Object]`,
        !/undefined|NaN|\[object Object\]/.test(text),
        text.slice(0, 120));
    }
  }

  /* ── Forms are driven, not reasoned about ─────────────────────────── */

  console.log('\nforms');
  await signIn(seeded.admin.email);
  await goToRoute('customers');

  await page.click('[data-action="new-customer"]');
  await page.waitForSelector('#f');
  await page.type('#f input[name=name]', 'Driven Ltd');
  const before = await seq();
  await page.click('#f button[type=submit]');
  await settledAfter(before);

  const created = await db.Customer.count({ where: { name: 'Driven Ltd' } });
  check('the new-customer dialog actually created a row', created === 1);

  /* ── Signing out is a control, so it is clicked ───────────────────── */

  console.log('\nsign-out');
  await signIn(seeded.admin.email);
  await goToRoute('customers');

  const outSeq = await seq();
  await page.click('[data-action="sign-out"]');
  await settledAfter(outSeq);
  check('signing out puts the sign-in form back',
        (await page.$('input[name=email]')) !== null);

  /* The session cookie is httpOnly, so nothing in the page could have
     dropped it — only /auth/logout can. A reload that still lands on the
     form is the proof that the server did, and not merely that the app
     stopped drawing the nav. The anonymous boot it provokes is the same
     expected pair of 401s that signing in provokes. */
  await expectingFailure(async () => {
    await page.reload({ waitUntil: 'networkidle0' });
  });
  check('the session did not survive the reload',
        (await page.$('input[name=email]')) !== null);

  /* A deliberate failure, forgiven precisely. */
  await expectingFailure(async () => {
    await openSignIn();
    await page.type('input[name=email]', seeded.admin.email);
    await page.type('input[name=password]', 'wrong-password');
    await page.click('button[type=submit]');
    await page.waitForSelector('#err:not([hidden])');
  });
  check('a wrong password is reported in the form, not as a blank screen', true);

  /* ── The landing page, and the button on it ───────────────────────────
     The one control on this product that an unknown person presses first. It
     is driven here for the same reason every form is: from inside the
     browser, a button that posts to a route that does not exist and a button
     whose request is refused look identical — nothing happens.
     ──────────────────────────────────────────────────────────────────── */

  console.log('\nthe landing page');

  /**
   * Press the demo button and say where it left us.
   *
   * The navigation is awaited to `networkidle0`, not merely to the commit:
   * the button replaces the document, and anything that polls inside the
   * page — `settledAfter` included — is polling a frame the navigation is
   * still detaching. Waiting for the new document to go quiet means the app
   * has already booted and painted by the time anything is asserted.
   */
  async function pressTheDemoButton() {
    await page.goto(`${url}/`, { waitUntil: 'networkidle0' });
    const navigated = page
      .waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 })
      .catch(() => null);
    await page.click('#try-demo');
    await navigated;

    const where = await page.evaluate(() => location.pathname);
    /* The page says why when it does not navigate, and that message is far
       more useful in a failing run than "expected /app.html, got /". */
    const said = await page.$eval('#demo-status', (el) => el.textContent).catch(() => '');
    return { where, said };
  }

  await expectingFailure(() => openSignIn());          // arrive as a stranger

  const anonymous = await pressTheDemoButton();
  check('the demo button hands a stranger a whole tenant',
        anonymous.where === '/app.html', anonymous.said || anonymous.where);
  await page.waitForSelector('.demo-banner', { timeout: 20000 });

  const demoOrgs = await db.Organization.count({ where: { is_demo: true } });
  check('a demo tenant really was provisioned', demoOrgs >= 1, `${demoOrgs} demo tenants`);

  check('the demo says when it goes away',
        (await page.$eval('.demo-banner', (el) => el.textContent)).includes('deleted'));

  const asOwner = await page.$$eval('.table tbody tr', (rows) => rows.length);
  check('the demo lands on a screen with data in it', asOwner > 0, `${asOwner} rows`);

  const demoText = await page.evaluate(() => document.body.innerText);
  check('the demo screen renders without undefined/NaN/[object Object]',
        !/undefined|NaN|\[object Object\]/.test(demoText), demoText.slice(0, 120));

  /* The switcher is the demo's whole argument: what you see depends on who
     you are. A <select> is a control, so it is used rather than reasoned
     about. */
  const cast = await page.$$eval('[data-action="demo-switch"] option',
    (options) => options.map((o) => ({ value: o.value, label: o.textContent })));
  const member = cast.filter((o) => / member$/.test(o.label))[0];

  if (!member) {
    check('the switcher offers another role', false, cast.map((o) => o.label).join(', '));
  } else {
    const before = await seq();
    await page.select('[data-action="demo-switch"]', member.value);
    await settledAfter(before);

    const asMember = await page.$$eval('.table tbody tr', (rows) => rows.length);
    check('switching role changes what the screen shows',
          asMember < asOwner, `${asMember} rows as a member, ${asOwner} as the owner`);

    const backTo = await page.$$eval('[data-action="demo-switch"] option',
      (options) => options.filter((o) => / admin$/.test(o.textContent)).length);
    check('and the way back is still on screen', backTo === 1);
  }

  /* Pressed a second time, from a browser that is already holding a session.
     The API demands the CSRF header from anything carrying a session cookie,
     so this is the press that fails 403 if the landing page — which does not
     load js/api.js — forgot to echo the token itself. */
  await signIn(seeded.admin.email);
  const returning = await pressTheDemoButton();
  check('the button still works for a browser that already has a session',
        returning.where === '/app.html', returning.said || returning.where);
  await page.waitForSelector('.demo-banner', { timeout: 20000 });

  /* ── An expired demo shows somebody the door ────────────────────────
     Every request the open screen makes is refused from here on, and Chrome
     logs each 403 as a console error. That is the correct behaviour being
     exercised rather than noise, so it is forgiven exactly here — and only
     here, and only for the length of this step.
     ──────────────────────────────────────────────────────────────────── */

  let shownTheDoor = false;
  await expectingFailure(async () => {
    await db.Organization.update(
      { expires_at: new Date(Date.now() - 1000) },
      { where: { is_demo: true } }
    );
    await page.evaluate(() => { location.hash = '#/tasks'; });
    shownTheDoor = await waitForPath('/');
  });

  check('an expired demo puts the visitor back on the landing page',
        shownTheDoor && (await page.$('#try-demo')) !== null,
        await page.evaluate(() => location.pathname));

  /* ── Report ───────────────────────────────────────────────────────── */

  check('the console stayed clean', noise.length === 0, noise.slice(0, 3).join(' | '));

  await browser.close();
  server.close();
  api.close();
  await db.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  failures.forEach((f) => console.log(`  ${RED}✗${RESET} ${f.name}`));
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
