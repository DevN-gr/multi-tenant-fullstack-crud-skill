/* ══════════════════════════════════════════════════════════════════════════
   The demo door — the second hand-written route file, and for the same
   reason as the first: provisioning a tenant is a transition, not a resource.
   There is no row called "a demo" to POST.

   Unauthenticated on purpose. That is the feature — somebody evaluating the
   product should not have to hand over an e-mail address to see it — and it
   is also the risk, so everything that bounds it lives in services/demo.js
   and is asked here before anything is written.

   Two endpoints:

     POST /demo          a tenant, seeded, and a session as its owner
     POST /demo/switch   become another member of that same tenant's cast

   The switch is what makes a demo of THIS architecture worth having: the
   product's claim is that what you can see depends on who you are, and the
   only way to show it is to let somebody be each of them in turn. It is also
   the one endpoint in the application that hands over another account's
   session, so read its guard twice.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { asyncRouter } = require('../utils/async-handler');
const auth = require('../middleware/auth');
const demo = require('../services/demo');
const sessions = require('../services/sessions');

module.exports = (db) => {
  const router = asyncRouter(express.Router());

  /**
   * A demo that is switched off answers 404, not 403.
   *
   * The same reason the API answers a record you may not read exactly as it
   * answers one that does not exist: a 403 here tells an unauthenticated
   * caller that there IS a demo endpoint on this deployment and that it is
   * merely closed, which is an invitation to keep asking. A feature nobody
   * turned on should look like a feature nobody wrote.
   */
  function offered(res) {
    if (demo.settings().enabled) return true;
    res.status(404).json({ error: 'not_found' });
    return false;
  }

  router.post('/', async (req, res) => {
    if (!offered(res)) return;

    /* `req.ip`, and app.js sets `trust proxy` — so behind Traefik this is the
       visitor's address from X-Forwarded-For rather than the proxy's, which
       is what makes the per-address limit mean anything. The corollary is
       that the header is the client's to write if this app is ever exposed
       without a proxy in front of it: the limit is a speed bump, and it is
       written down as one. */
    const result = await demo.provision(db, { ip: req.ip });

    if (result.error) {
      /* 429 rather than 503: the request was understood and refused for rate,
         and a client that reads Retry-After can wait the right amount. */
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: result.error });
    }

    await sessions.open(db, res, result.owner, { notAfter: result.org.expires_at });
    res.json({ user: await sessions.principalFor(db, result.owner) });
  });

  /**
   * Become somebody else inside the SAME demo tenant.
   *
   * Four conditions, and every one of them is load-bearing:
   *
   *   1. There is a session, and it belongs to a demo tenant. A principal in
   *      a real organization must never reach this handler, or the product
   *      grows an impersonation endpoint nobody asked for.
   *   2. The tenant has not expired, checked here because this route sits
   *      outside the guarded router and therefore outside tenant.js.
   *   3. The target is in that same tenant — read with the organization id
   *      from the SESSION, never from the body, so the id in the body cannot
   *      name somebody else's account.
   *   4. The target is active.
   *
   * Anything else is answered as if the account did not exist.
   */
  router.post('/switch', auth.needAuth, async (req, res) => {
    if (!offered(res)) return;

    const org = req.user.organization;
    if (!org || !org.is_demo) return res.status(403).json({ error: 'forbidden' });
    if (demo.hasExpired(org)) return res.status(403).json({ error: 'demo_expired' });

    /* Coerced here, because this route is hand-written and therefore outside
       the factory that does it for every other endpoint. A browser sends an
       id from a <select> as text, and Sequelize throws on an undefined in a
       WHERE — which is a 500 for a request that is merely malformed. */
    const targetId = Number(req.body && req.body.UserId);
    if (!Number.isInteger(targetId)) return res.status(404).json({ error: 'not_found' });

    const target = await db.User.findOne({
      where: {
        id: targetId,
        OrganizationId: org.id,          // from the session, not the body
        status: 'active'
      }
    });
    if (!target) return res.status(404).json({ error: 'not_found' });

    await sessions.open(db, res, target, { notAfter: org.expires_at });
    res.json({ user: await sessions.principalFor(db, target) });
  });

  return router;
};
