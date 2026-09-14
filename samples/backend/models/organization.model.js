/* The tenant. Everything else in the schema hangs off one of these, and no
   query anywhere is allowed to cross between two. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const Organization = sequelize.define('Organization', {
    name: { type: DataTypes.STRING, allowNull: false },
    slug: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('active', 'suspended'), allowNull: false, defaultValue: 'active' },

    /* ── The throwaway tenant ─────────────────────────────────────────────
       A demo is a tenant in every respect — same tables, same scope filters,
       same controllers — and these three columns are the entire difference.
       A flag on the tenant rather than a "demo mode" is what keeps the demo
       honest: a visitor exercises the code paying customers run, not a second
       implementation of it that is free to drift. It also means the tenant
       boundary protects the demo without anybody writing a rule for it.
       ─────────────────────────────────────────────────────────────────── */
    is_demo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    /* When the tenant stops answering, and when the sweeper may delete it.
       Null for a real organization — NOT a date far in the future, because
       the sweeper asks `expires_at < now` and a real tenant must not be one
       clock skew away from matching that query. */
    expires_at: { type: DataTypes.DATE, allowNull: true },

    /* The address that asked for this demo, for the per-IP limit and nothing
       else. 45 characters is an IPv6 address with an IPv4 tail. It is
       personal data with a one-day life: it goes when the tenant goes, and
       organization.controller.js hides it from every role but the platform's. */
    created_ip: { type: DataTypes.STRING(45), allowNull: true }
  }, {
    paranoid: true,
    indexes: [
      { fields: ['status', 'name'] },
      /* The sweeper asks which demos have expired and the door asks how many
         are live. Both are this index, in this order. */
      { fields: ['is_demo', 'expires_at'] }
    ]
  });

  return Organization;
};
