/* A site, team or branch inside one organization: the second scope boundary,
   under the tenant. Staff are either network-wide (`all_workspaces`) or
   attached to named workspaces, which is what stops one team reading
   another's rows. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const Workspace = sequelize.define('Workspace', {
    OrganizationId: { type: DataTypes.INTEGER, allowNull: false },
    code: { type: DataTypes.STRING(16), allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    city: { type: DataTypes.STRING, allowNull: true },
    address: { type: DataTypes.STRING, allowNull: true }
  }, {
    paranoid: true,
    indexes: [{ fields: ['OrganizationId', 'name'] }]
  });

  return Workspace;
};
