/* ══════════════════════════════════════════════════════════════════════════
   The demo tenant: the door, the expiry and the broom.

   A visitor presses one button on the landing page and gets a whole tenant of
   their own, seeded and signed in, with no sign-up. A day later it is gone —
   every row of it.

   Three things make that safe enough to leave switched on:

     • **It is an ordinary tenant.** Same tables, same scope filters, same
       controllers. Nothing anywhere says "if demo, then". The tenant boundary
       that keeps two customers apart is the one that keeps a demo away from
       real data, and it is already tested per role over real HTTP.

     • **Expiry is enforced on the request, not by the timer.** A tenant is
       dead the moment its `expires_at` passes, because middleware/tenant.js
       refuses it — see `hasExpired`. The sweeper below is about storage. If
       it were the only thing standing between an expired demo and its data, a
       crashed timer would silently extend every demo for ever.

     • **The door is metered.** An unauthenticated endpoint that writes a
       hundred rows is a write amplifier pointed at your database, so there is
       a ceiling on how many demos can be alive at once and a speed bump per
       address. Neither is a security control; both bound a bad afternoon.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { Op } = require('sequelize');
const c = require('../config-dir');
const logger = require('../utils/logger');
const seedDemoTenant = require('../seed/demo');

/** Read at call time, not at require time, so a test can boot a process with
    different settings and get them. */
function settings() {
  return {
    enabled: c.get('demo.enabled'),
    ttlHours: c.get('demo.ttl_hours'),
    maxLive: c.get('demo.max_live'),
    perIpMinutes: c.get('demo.per_ip_minutes'),
    sweepMinutes: c.get('demo.sweep_minutes')
  };
}

/**
 * Has this tenant's day run out?
 *
 * The one definition, used by the request path and by the sweeper, so a
 * tenant can never be dead to one and alive to the other. A real organization
 * has no `expires_at` and is never expired.
 */
function hasExpired(org, now = new Date()) {
  if (!org || !org.expires_at) return false;
  return new Date(org.expires_at).getTime() <= now.getTime();
}

/**
 * Whether the door opens, given what is behind it. Pure, and therefore the
 * part that is tested exhaustively — the HTTP tests only have to prove the
 * route asks it.
 *
 * @param {{liveCount: number, msSinceIpLast: number|null}} state
 * @param {object} s - settings()
 * @returns {string|null} an error code, or null to proceed
 */
function refusalFor(state, s) {
  if (!s.enabled) return 'demo_disabled';

  /* Asked before capacity on purpose: somebody who provisioned a demo ninety
     seconds ago is far likelier to be holding one already than to be an
     abuser, and "you have one open" is the more useful of the two answers. */
  if (s.perIpMinutes > 0 && state.msSinceIpLast !== null &&
      state.msSinceIpLast < s.perIpMinutes * 60 * 1000) {
    return 'demo_cooldown';
  }

  if (state.liveCount >= s.maxLive) return 'demo_unavailable';

  return null;
}

/** What the door needs to know: how many are live, and when this address last
    asked. Both read `paranoid: false`, because a demo that was soft-deleted
    through the API still owns every one of its rows. */
async function doorState(db, { ip, now, s }) {
  const liveCount = await db.Organization.count({
    where: { is_demo: true, expires_at: { [Op.gt]: now } },
    paranoid: false
  });

  let msSinceIpLast = null;
  if (s.perIpMinutes > 0 && ip) {
    /* The window is the row's own age, so the speed bump forgets as soon as
       the sweeper deletes the tenant. That is the honest limit of it: it
       spaces out ordinary visitors and it is not what stops a determined
       one — the ceiling above is. */
    const last = await db.Organization.findOne({
      where: { is_demo: true, created_ip: ip },
      order: [['createdAt', 'DESC']],
      attributes: ['createdAt'],
      paranoid: false
    });
    if (last) msSinceIpLast = now.getTime() - new Date(last.createdAt).getTime();
  }

  return { liveCount, msSinceIpLast };
}

/**
 * Provision one demo tenant, or say why not.
 *
 * @returns {Promise<{error: string, retryAfter: number}|{org: object, owner: object}>}
 */
async function provision(db, { ip = null, now = new Date() } = {}) {
  const s = settings();
  const refusal = refusalFor(await doorState(db, { ip, now, s }), s);
  if (refusal) {
    /* The ceiling clears when the next demo expires, which nobody can predict
       from out here, so the hint is the sweep interval rather than a
       guess dressed up as a promise. */
    const retryAfter = refusal === 'demo_cooldown'
      ? s.perIpMinutes * 60
      : Math.max(60, s.sweepMinutes * 60);
    return { error: refusal, retryAfter };
  }

  /* The cap is a budget, not an invariant: two requests can both read
     `maxLive - 1` and both proceed. Overshooting by the number of concurrent
     visitors costs one extra demo tenant for a day, and buying an invariant
     here would cost a lock on the busiest table in the product. */
  const expiresAt = new Date(now.getTime() + s.ttlHours * 60 * 60 * 1000);

  const seeded = await db.sequelize.transaction(
    (transaction) => seedDemoTenant(db, { transaction, expiresAt, ip, now })
  );

  logger.info({ slug: seeded.org.slug, expires_at: expiresAt }, 'Provisioned a demo tenant');
  return seeded;
}

/* ── The broom ────────────────────────────────────────────────────────────

   Children before parents, because sync() creates the foreign keys and the
   database enforces them.

   Every destroy passes `force: true`, and that is the whole point of this
   list. These models are `paranoid`, so an ordinary destroy writes a
   `deletedAt` and keeps the row — which would make "deleted after a day" a
   sentence that is false in the only way that matters: the data is still
   there, for ever, growing, in a table nobody thinks to look at.
   ──────────────────────────────────────────────────────────────────────── */
const PURGE_ORDER = ['AuditEntry', 'Note', 'Task', 'Customer', 'UserWorkspace', 'Workspace', 'User'];

/** Delete one tenant and everything that belongs to it. */
async function purge(db, organizationId) {
  /* Sessions hang off the user rather than the organization, so they are not
     in the list above and would outlive the tenant: a refresh cookie against
     a deleted user, presented for as long as the token lasts. */
  const users = await db.User.findAll({
    where: { OrganizationId: organizationId },
    attributes: ['id'],
    paranoid: false
  });
  const userIds = users.map((u) => u.id);

  await db.sequelize.transaction(async (transaction) => {
    if (userIds.length) {
      await db.AuthToken.destroy({
        where: { UserId: { [Op.in]: userIds } }, force: true, transaction
      });
    }
    for (const name of PURGE_ORDER) {
      await db[name].destroy({
        where: { OrganizationId: organizationId }, force: true, transaction
      });
    }
    await db.Organization.destroy({ where: { id: organizationId }, force: true, transaction });
  });
}

/**
 * Delete every demo whose day has run out.
 *
 * @returns {Promise<number>} how many tenants went.
 */
async function sweep(db, { now = new Date() } = {}) {
  const expired = await db.Organization.findAll({
    where: { is_demo: true, expires_at: { [Op.lt]: now } },
    attributes: ['id', 'slug'],
    paranoid: false
  });

  let purged = 0;
  for (const org of expired) {
    /* One tenant failing must not abandon the rest: the next sweep would find
       the same one first and stop there again, and nothing would ever be
       deleted after the first bad row. */
    try {
      await purge(db, org.id);
      purged += 1;
    } catch (err) {
      logger.error({ err, slug: org.slug }, 'Could not purge an expired demo tenant');
    }
  }

  if (purged) logger.info({ purged }, 'Swept expired demo tenants');
  return purged;
}

/**
 * Run the sweep on boot and on an interval.
 *
 * On boot as well as on the interval, because a timer only covers uptime: a
 * box that was off over a long weekend comes back holding demos from before
 * it went down, and nothing but a start-up sweep will ever notice them.
 *
 * The timer is `unref`'d so it cannot hold the process open — a suite that
 * finishes its assertions and then waits fifteen minutes to exit reads as a
 * hung test run.
 */
function startSweeper(db) {
  const s = settings();
  if (!s.enabled) return null;

  const run = () => sweep(db).catch((err) => logger.error({ err }, 'Demo sweep failed'));

  run();
  const timer = setInterval(run, Math.max(1, s.sweepMinutes) * 60 * 1000);
  timer.unref();

  return { stop: () => clearInterval(timer) };
}

module.exports = { settings, hasExpired, refusalFor, provision, purge, sweep, startSweeper, PURGE_ORDER };
