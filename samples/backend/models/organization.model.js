/* The tenant. Everything else in the schema hangs off one of these, and no
   query anywhere is allowed to cross between two. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const Organization = sequelize.define('Organization', {
    name: { type: DataTypes.STRING, allowNull: false },
    slug: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('active', 'suspended'), allowNull: false, defaultValue: 'active' }
  }, {
    paranoid: true,
    indexes: [{ fields: ['status', 'name'] }]
  });

  return Organization;
};
