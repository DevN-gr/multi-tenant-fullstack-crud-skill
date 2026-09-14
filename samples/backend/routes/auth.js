/* ══════════════════════════════════════════════════════════════════════════
   Signing in — one of the two hand-written route files, the other being
   routes/demo.js.

   Both are here for the same reason: a transition is not a resource. There is
   no row called "a session" to POST, and no row called "a demo tenant"
   either. Everything that IS a resource goes through crudThat.

   What the browser gets back is three cookies and a JSON principal:

     <app>_at    the access token — httpOnly, so a script cannot read it
     <app>_rt    the refresh token — httpOnly, rotated on every use
     <app>_csrf  readable on purpose; the client echoes it in a header

   Every handler is wrapped. Express 4 turns a rejected async handler into an
   unhandled rejection, and Node exits the process on one — a single
   unauthenticated POST against a misconfigured mailer is enough to take the
   API down with no response ever sent.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { asyncRouter } = require('../utils/async-handler');
const c = require('../config-dir');
const auth = require('../middleware/auth');
const csrf = require('../middleware/csrf');
const passwords = require('../services/passwords');
const sessions = require('../services/sessions');

module.exports = (db) => {
  const router = asyncRouter(express.Router());

  /* Opening a session and describing the principal both live in
     services/sessions.js, because routes/demo.js opens one too and a second
     copy of "cookies, refresh token, CSRF token" is a copy that forgets one
     of the three. */
  const principal = (user) => sessions.principalFor(db, user);

  /** When this user's tenant stops existing, or null for an ordinary one. */
  async function tenantExpiry(user) {
    if (!user.OrganizationId) return null;
    const org = await db.Organization.findByPk(user.OrganizationId, { attributes: ['expires_at'] });
    return org ? org.expires_at : null;
  }

  router.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = await db.User.findOne({ where: { email } });

    /* The same answer and the same cost for "no such account" and "wrong
       password". passwords.verify hashes against a dummy when there is no
       stored hash, so the timing does not say which it was. */
    const ok = user && user.status === 'active' &&
      await passwords.verify(req.body.password, user.password);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

    await sessions.open(db, res, user);
    res.json({ user: await principal(user) });
  });

  router.post('/refresh', async (req, res) => {
    const presented = req.cookies && req.cookies[auth.REFRESH_COOKIE];
    if (!presented) return res.status(401).json({ error: 'unauthenticated' });

    const row = await db.AuthToken.findOne({
      where: { kind: 'refresh', token_hash: passwords.hashToken(presented), used_at: null }
    });
    if (!row || row.expires_at < new Date()) {
      return res.status(401).json({ error: 'unauthenticated' });
    }

    const user = await db.User.findOne({ where: { id: row.UserId, status: 'active' } });
    if (!user) return res.status(401).json({ error: 'unauthenticated' });

    /* Rotated, not reused: a refresh token that survives its own use is a
       refresh token somebody else can still present. */
    await row.update({ used_at: new Date() });
    /* Capped at the tenant's own life where it has one, so refreshing a demo
       session cannot walk it past the day the tenant is deleted. */
    await sessions.open(db, res, user, { notAfter: await tenantExpiry(user) });
    res.json({ user: await principal(user) });
  });

  router.post('/logout', async (req, res) => {
    if (req.user) {
      await db.AuthToken.update(
        { used_at: new Date() },
        { where: { UserId: req.user.id, kind: 'refresh', used_at: null } }
      );
    }
    auth.clearSession(res);
    csrf.clear(res);
    res.json({ status: 'OK' });
  });

  /* The client boots from this: who am I, and what may I do. */
  router.get('/me', auth.needAuth, async (req, res) => {
    const user = await db.User.findByPk(req.user.id);
    if (!user) return res.status(401).json({ error: 'unauthenticated' });
    res.json({ user: await principal(user) });
  });

  router.post('/change-password', auth.needAuth, async (req, res) => {
    const user = await db.User.findByPk(req.user.id);
    const ok = await passwords.verify(req.body.current, user.password);
    if (!ok) return res.status(403).json({ error: 'wrong_password' });
    if (String(req.body.next || '').length < c.get('auth.min_password_length')) {
      return res.status(422).json({ error: 'password_too_short' });
    }
    await user.update({ password: await passwords.hash(req.body.next) });
    res.json({ status: 'OK' });
  });

  return router;
};
