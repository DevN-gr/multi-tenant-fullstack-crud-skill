/* ══════════════════════════════════════════════════════════════════════════
   First boot.

   On an empty database, put somebody in it who can create the first
   organization. Without this a fresh deployment has no way in at all — and
   with a working default password it would have a known way in, which is
   worse. The password comes from the environment and the process refuses to
   start on the placeholder outside development.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const c = require('../config-dir');
const logger = require('../utils/logger');
const passwords = require('../services/passwords');

module.exports = async function bootstrap(db) {
  const existing = await db.User.count();
  if (existing) return null;

  const password = c.get('superadmin.password');
  const env = process.env.NODE_ENV || 'development';

  if ((!password || password === 'change-me' || password.length < 12) &&
      env !== 'development' && env !== 'test') {
    throw new Error('SUPERADMIN_PASSWORD must be set to a real value outside development');
  }

  const user = await db.User.create({
    OrganizationId: null,                  // the one principal outside a tenant
    name: c.get('superadmin.name'),
    email: String(c.get('superadmin.email')).toLowerCase(),
    password: await passwords.hash(password),
    user_type: 'superadmin',
    status: 'active'
  });

  logger.info({ email: user.email }, 'Bootstrapped the platform account');
  return user;
};
