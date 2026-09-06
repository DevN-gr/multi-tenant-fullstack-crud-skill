/* ══════════════════════════════════════════════════════════════════════════
   Password hashing and token minting.

   bcryptjs rather than bcrypt: pure JavaScript, so neither the production
   image nor a developer's laptop needs a native toolchain to install the
   backend. The cost factor is configuration — 12 everywhere, 4 under test,
   because the suite hashes hundreds of passwords and bcrypt cost would
   otherwise be the entire runtime.

   Tokens are random 32-byte values, handed out once in an e-mail and stored
   only as their SHA-256. A database dump is then not a pile of working links.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const c = require('../config-dir');

const ROUNDS = c.get('auth.bcrypt_rounds');

/** Hash a plaintext password for storage. */
async function hash(plain) {
  return bcrypt.hash(String(plain), ROUNDS);
}

/**
 * Check a password against a stored hash.
 *
 * A user with no password — invited but never activated — must still cost the
 * same as a wrong password, or the timing difference tells an attacker which
 * addresses have live accounts.
 */
async function verify(plain, stored) {
  if (!stored) {
    await bcrypt.compare(String(plain), '$2a$04$' + 'x'.repeat(53));
    return false;
  }
  return bcrypt.compare(String(plain), stored);
}

/** A fresh token: the plaintext to send, and the hash to store. */
function mintToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time string comparison, for CSRF tokens and the like. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { hash, verify, mintToken, hashToken, safeEqual, ROUNDS };
