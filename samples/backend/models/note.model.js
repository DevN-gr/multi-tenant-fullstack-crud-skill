/* ══════════════════════════════════════════════════════════════════════════
   Note — the restricted model.

   This is the sample's stand-in for whatever a product holds that only some
   roles may read: a medical record, an HR file, a legal matter. The `agent`
   role is refused it outright — including indirectly, through `?include=` and
   through the audit trail — and that refusal is asserted per role over real
   HTTP in test/access.test.js.

   Keep one model like this in any project with a real access model. Rules
   that are only ever exercised on the permissive path are rules nobody has
   tested.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const Note = sequelize.define('Note', {
    OrganizationId: { type: DataTypes.INTEGER, allowNull: false },
    CustomerId: { type: DataTypes.INTEGER, allowNull: false },
    MemberId: { type: DataTypes.INTEGER, allowNull: false },

    date: { type: DataTypes.STRING(10), allowNull: false },
    body: { type: DataTypes.TEXT, allowNull: false },
    /* Visible to the customer in their portal, or internal only. */
    shared: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
  }, {
    paranoid: true,
    indexes: [
      { fields: ['OrganizationId', 'CustomerId', 'date'] },
      { fields: ['OrganizationId', 'MemberId'] }
    ]
  });

  return Note;
};
