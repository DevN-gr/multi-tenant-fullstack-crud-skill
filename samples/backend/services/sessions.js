/* ══════════════════════════════════════════════════════════════════════════
   Opening a session, and describing who holds it.

   Two route files sign somebody in — routes/auth.js for a password and
   routes/demo.js for a throwaway tenant — and both have to do exactly the
   same three things: mint a refresh token, set the cookies, issue a CSRF
   token. Written twice, the second copy is the one that forgets the CSRF
   token and leaves a session that can read and cannot write.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const auth = require('../middleware/auth');
const csrf = require('../middleware/csrf');
const capabilities = require('./capabilities');
const passwords = require('./passwords');

/**
 * A fresh refresh token for `user`, stored as its hash.
 *
 * `notAfter` caps the token's life at the tenant's own, which matters in one
 * narrow window: between a demo expiring and the sweeper deleting its tokens,
 * an uncapped refresh would hand out a fresh half-hour session for a tenant
 * that every other request already refuses. The cookie in the browser may
 * outlive both — this row is the authority, and a token that is not in it is
 * not a token.
 */
async function issueRefresh(db, user, { notAfter } = {}) {
  const { token, hash } = passwords.mintToken();
  let expires = new Date(Date.now() + auth.refreshTtlMs());
  if (notAfter && new Date(notAfter) < expires) expires = new Date(notAfter);

  await db.AuthToken.create({
    UserId: user.id,
    kind: 'refresh',
    token_hash: hash,
    expires_at: expires
  });
  return token;
}

/** Put a signed-in session for `user` on this response. */
async function open(db, res, user, { notAfter } = {}) {
  auth.setSession(res, user, await issueRefresh(db, user, { notAfter }));
  csrf.issue(res);
}

/**
 * The principal, as the browser needs it.
 *
 * Capabilities travel with it so the frontend has one definition of the
 * access model rather than a second one written out in its own source.
 *
 * `demo` is null for every real tenant and is the only thing that tells the
 * app it is running inside a throwaway one — which it has to know, because it
 * owes the visitor a banner saying when the data goes.
 */
async function principalFor(db, user) {
  const principal = {
    id: user.id,
    name: user.name,
    email: user.email,
    user_type: user.user_type,
    OrganizationId: user.OrganizationId,
    all_workspaces: user.all_workspaces,
    capabilities: capabilities.listFor(user.user_type),
    demo: null
  };

  if (!user.OrganizationId) return principal;

  const org = await db.Organization.findByPk(user.OrganizationId, {
    attributes: ['id', 'is_demo', 'expires_at']
  });
  if (!org || !org.is_demo) return principal;

  /* The cast travels with the principal rather than being read from
     /users, because the role somebody switches TO may not be visible from
     the role they are in — a member cannot list the owner. A switcher that
     cannot get back to where it started is a demo that dead-ends on its
     second click.

     Safe to send because it names only accounts inside a tenant this
     session already holds the keys to, and because none of them has a
     password to be guessed. */
  const cast = await db.User.findAll({
    where: { OrganizationId: org.id, status: 'active' },
    attributes: ['id', 'name', 'user_type'],
    order: [['id', 'ASC']]
  });

  principal.demo = {
    expires_at: org.expires_at,
    cast: cast.map((u) => ({ id: u.id, name: u.name, user_type: u.user_type }))
  };
  return principal;
}

module.exports = { issueRefresh, open, principalFor };
