/* ══════════════════════════════════════════════════════════════════════════
   AuditEntry — one row per changed field.

   Who, when, which record, which field, from what value, to what value. A
   single action touching three fields writes three rows, which is what makes
   "show me every time this moved" a filter rather than a text search.

   `from_value` and `to_value` are strings, and deliberately so: the trail
   records what a person saw and changed, not what a column's type was.

   The table is bounded per organization — see services/audit.js `trim`. A
   trail nobody prunes grows without limit, and nobody reads the
   four-thousand-and-first most recent entry.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const LIMIT = 4000;

module.exports = (sequelize, DataTypes) => {
  const AuditEntry = sequelize.define('AuditEntry', {
    OrganizationId: { type: DataTypes.INTEGER, allowNull: false },

    date: { type: DataTypes.STRING(10), allowNull: false },
    time: { type: DataTypes.STRING(5), allowNull: false },

    /* Denormalised on purpose: the actor's name as it was at the time. A join
       would show who they are called now, which is not what happened. */
    UserId: { type: DataTypes.INTEGER, allowNull: true },
    user_name: { type: DataTypes.STRING, allowNull: false },
    user_role: { type: DataTypes.STRING(32), allowNull: false },

    entity: { type: DataTypes.STRING(32), allowNull: false },
    entity_id: { type: DataTypes.INTEGER, allowNull: true },
    label: { type: DataTypes.STRING, allowNull: true },

    /* Scope columns, so the trail can be filtered by the same boundaries the
       records themselves are — and so a role that may not read notes cannot
       read them through their audit rows either. */
    WorkspaceId: { type: DataTypes.INTEGER, allowNull: true },
    CustomerId: { type: DataTypes.INTEGER, allowNull: true },
    MemberId: { type: DataTypes.INTEGER, allowNull: true },

    action: { type: DataTypes.ENUM('create', 'update', 'delete'), allowNull: false, defaultValue: 'update' },
    field: { type: DataTypes.STRING(64), allowNull: false },
    from_value: { type: DataTypes.STRING, allowNull: true },
    to_value: { type: DataTypes.STRING, allowNull: true }
  }, {
    paranoid: false,
    indexes: [
      { fields: ['OrganizationId', 'date', 'time'] },
      { fields: ['OrganizationId', 'entity', 'entity_id'] },
      { fields: ['OrganizationId', 'CustomerId'] }
    ]
  });

  AuditEntry.LIMIT = LIMIT;
  return AuditEntry;
};
