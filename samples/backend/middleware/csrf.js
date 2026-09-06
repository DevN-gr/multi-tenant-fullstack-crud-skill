/* ══════════════════════════════════════════════════════════════════════════
   CSRF — the cost of holding the session in a cookie.

   A cookie is sent by the browser on any request to this origin, including
   one a hostile page triggered. SameSite=Lax blocks the cross-site POST in
   every browser that honours it, and this is the second lock: a random value
   in a readable cookie that the client must echo in a header. A cross-origin
   page can cause the cookie to be sent but cannot read it, so it cannot
   produce the header.

   Deliberately not httpOnly — the frontend has to read it to echo it. That is
   safe: the CSRF token authorises nothing on its own.

   Safe methods pass through. So does a request carrying no session at all:
   there is nothing to forge.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const c = require('../config-dir');
const passwords = require('../services/passwords');
const { COOKIE } = require('./auth');

const CSRF_COOKIE = c.get('auth.csrf_cookie_name');
const CSRF_HEADER = c.get('auth.csrf_header');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Issue a CSRF token alongside a new session. */
function issue(res) {
  const token = crypto.randomBytes(24).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,               // the client must read it — see the header
    secure: c.get('auth.cookie_secure'),
    sameSite: c.get('auth.cookie_same_site'),
    path: '/'
  });
  return token;
}

function clear(res) {
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

function protect(req, res, next) {
  if (SAFE.has(req.method)) return next();

  /* No session cookie, nothing to ride on. Sign-in and forgot-password are
     unauthenticated POSTs and would otherwise be unreachable on a cold load. */
  if (!req.cookies || !req.cookies[COOKIE]) return next();

  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);

  if (!cookie || !header || !passwords.safeEqual(cookie, header)) {
    return res.status(403).json({ error: 'csrf' });
  }
  next();
}

module.exports = { protect, issue, clear, CSRF_COOKIE, CSRF_HEADER };
