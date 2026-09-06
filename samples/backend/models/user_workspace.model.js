/* The explicit join behind `User.belongsToMany(Workspace)`.

   Explicit rather than implicit because the scope filter reads it directly —
   `WHERE WorkspaceId IN (…)` — and an index on a table Sequelize invented is
   an index nobody can declare. Nothing writes this through the API: it is
   mounted read-only. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const UserWorkspace = sequelize.define('UserWorkspace', {
    OrganizationId: { type: DataTypes.INTEGER, allowNull: false },
    UserId: { type: DataTypes.INTEGER, allowNull: false },
    WorkspaceId: { type: DataTypes.INTEGER, allowNull: false }
  }, {
    paranoid: false,
    indexes: [
      { fields: ['UserId', 'WorkspaceId'], unique: true },
      { fields: ['WorkspaceId'] }
    ]
  });

  return UserWorkspace;
};
