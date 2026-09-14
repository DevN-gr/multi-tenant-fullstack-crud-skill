/* ══════════════════════════════════════════════════════════════════════════
   Authentication — a JWT the browser cannot read.

   The access token lives in an httpOnly, SameSite=Lax cookie rather than
   localStorage. This app renders customer names, free-text notes and private
   history; if a single escaping mistake ever lets a script run, an
   XSS-readable token hands over the whole session. httpOnly means the token
   is not reachable from JavaScript at all, so that class of bug costs a
   defaced page rather than a stolen account.

   The price is CSRF, which cookies reintroduce and middleware/csrf.js pays.

   The principal is re-read from the database on every request, not trusted
   from the token's claims. A user disabled, moved or re-scoped a minute ago
   must not keep the access their old token still asserts; a 30-minute window
   of stale authority is not acceptable for a private record.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const jwt = require('jsonwebtoken');
const c = require('../config-dir');
const logger = require('../utils/logger');
const capabilities = require('../services/capabilities');

const COOKIE = c.get('auth.cookie_name');
const REFRESH_COOKIE = c.get('auth.refresh_cookie_name');

/**
 * The signing secret.
 *
 * Outside development there must be a real one: a JWT signed with a
 * predictable key is a JWT anyone can mint, so the process refuses to start
 * rather than come up insecure. Development gets a fixed throwaway, which
 * also means restarting the server does not sign everybody out.
 */
function secret() {
  if (c.has('auth.jwt_secret') && c.get('auth.jwt_secret')) return c.get('auth.jwt_secret');
  const env = process.env.NODE_ENV || 'development';
  if (env !== 'development' && env !== 'test') {
    throw new Error('JWT_SECRET must be set outside development');
  }
  return 'acme-development-secret-not-for-deployment';
}

function accessTtlMs() { return c.get('auth.access_ttl_minutes') * 60 * 1000; }
function refreshTtlMs() { return c.get('auth.refresh_ttl_days') * 24 * 3600 * 1000; }

function sign(user) {
  return jwt.sign(
    { sub: String(user.id), typ: user.user_type, org: user.OrganizationId || null },
    secret(),
    { expiresIn: Math.floor(accessTtlMs() / 1000) }
  );
}

function cookieOptions(maxAgeMs) {
  const options = {
    httpOnly: true,
    secure: c.get('auth.cookie_secure'),
    sameSite: c.get('auth.cookie_same_site'),
    path: '/',
    maxAge: maxAgeMs
  };
  if (c.has('auth.cookie_domain') && c.get('auth.cookie_domain')) {
    options.domain = c.get('auth.cookie_domain');
  }
  return options;
}

/** Put a signed-in session on the response. */
function setSession(res, user, refreshToken) {
  res.cookie(COOKIE, sign(user), cookieOptions(accessTtlMs()));
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(refreshTtlMs()));
  }
}

function clearSession(res) {
  const options = { ...cookieOptions(0) };
  delete options.maxAge;
  res.clearCookie(COOKIE, options);
  res.clearCookie(REFRESH_COOKIE, options);
}

/**
 * Resolve the principal from the access cookie, or leave req.user unset.
 * Never rejects — `needAuth` decides what an anonymous request means.
 */
function attachUser(db) {
  return async function attach(req, res, next) {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) return next();

    let claims;
    try {
      claims = jwt.verify(token, secret());
    } catch (err) {
      /* Expired is ordinary — the client will refresh. Anything else is
         worth a line, because it means a token that did not come from us. */
      if (err.name !== 'TokenExpiredError') {
        logger.warn({ error: err.name }, 'Rejected an access token');
      }
      return next();
    }

    const user = await db.User.findOne({
      where: { id: claims.sub, status: 'active' },
      include: [
        { model: db.UserWorkspace, as: 'UserWorkspaces', attributes: ['WorkspaceId'], required: false },
        /* Joined here rather than fetched again in middleware/tenant.js: the
           principal is already being read on every request, and the tenant's
           own state — is it a demo, has its day run out — has to be known
           before any controller hook runs. A second query per request to
           learn it would be a second query per request for ever. */
        { model: db.Organization, attributes: ['id', 'status', 'is_demo', 'expires_at'], required: false }
      ]
    });
    if (!user) return next();

    req.user = {
      id: user.id,
      user_type: user.user_type,
      OrganizationId: user.OrganizationId,
      name: user.name,
      email: user.email,
      all_workspaces: user.all_workspaces,
      workspaceIds: (user.UserWorkspaces || []).map((uc) => uc.WorkspaceId),
      capabilities: capabilities.listFor(user.user_type),
      /* The tenant itself, as a plain object. middleware/tenant.js reads it
         to refuse an expired demo, and routes/demo.js to refuse a switch
         outside one. Null for the superadmin, who stands outside every
         tenant. */
      organization: user.Organization ? {
        id: user.Organization.id,
        status: user.Organization.status,
        is_demo: user.Organization.is_demo,
        expires_at: user.Organization.expires_at
      } : null,
      /* Set by middleware/tenant.js for portal logins. */
      CustomerId: null
    };
    req.userRow = user;
    next();
  };
}

/** Refuse anything without a principal. */
function needAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

/** Refuse anything without a given capability. */
function needCap(cap) {
  return function guard(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!capabilities.can(req.user.user_type, cap)) {
      return res.status(403).json({ error: 'forbidden', capability: cap });
    }
    next();
  };
}

module.exports = {
  attachUser, needAuth, needCap, setSession, clearSession,
  sign, secret, cookieOptions, accessTtlMs, refreshTtlMs,
  COOKIE, REFRESH_COOKIE
};
