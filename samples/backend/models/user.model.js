/* ══════════════════════════════════════════════════════════════════════════
   User — a principal.

   `user_type` is the role, and it is the axis every access rule turns on:
   services/capabilities.js maps it to what may be done, and each controller's
   extraFilters maps it to what may be seen. Roles are a closed enum on
   purpose — a role that can be typed in is a role no test enumerates.

     superadmin  the platform. Creates organizations; holds no tenant data.
     admin       the organization's owner. Everything inside their own tenant.
     member      does the work. Their own customers and their own notes.
     agent       the front desk. Everything except the private notes.
     customer    the portal. Their own record, read-mostly.

   `password` is hashed and never leaves the server: crud.js excludes it from
   every response, from every filter and from every sort.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const ROLES = ['superadmin', 'admin', 'member', 'agent', 'customer'];

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    /* Null for the superadmin alone — the one principal outside every tenant.
       middleware/tenant.js refuses any other role that reaches a tenant route
       without one. */
    OrganizationId: { type: DataTypes.INTEGER, allowNull: true },

    name: { type: DataTypes.STRING, allowNull: false },
    /* Nullable: somebody can be on the books before they are given a login.
       Unique platform-wide, because sign-in names no tenant. */
    email: { type: DataTypes.STRING, allowNull: true, unique: true },
    password: { type: DataTypes.STRING, allowNull: true },

    user_type: { type: DataTypes.ENUM(...ROLES), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'invited', 'disabled'), allowNull: false, defaultValue: 'invited' },

    /* Network-wide staff, versus staff attached to named workspaces through
       UserWorkspace. services/scope.js reads this. */
    all_workspaces: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
  }, {
    paranoid: true,
    indexes: [
      { fields: ['OrganizationId', 'user_type', 'name'] },
      { fields: ['OrganizationId', 'status'] }
    ]
  });

  User.ROLES = ROLES;
  return User;
};
