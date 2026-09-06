/* The record the product is about. Tenant-scoped, workspace-scoped, and
   assigned to one member — three columns, and every access rule in
   customer.controller.js is written against them. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const Customer = sequelize.define('Customer', {
    OrganizationId: { type: DataTypes.INTEGER, allowNull: false },
    WorkspaceId: { type: DataTypes.INTEGER, allowNull: false },
    /* Who owns the relationship. `member.view.own` is scoped by this column. */
    MemberId: { type: DataTypes.INTEGER, allowNull: true },
    /* The portal login, once one has been invited. */
    UserId: { type: DataTypes.INTEGER, allowNull: true },

    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: true },
    phone: { type: DataTypes.STRING(32), allowNull: true },
    status: { type: DataTypes.ENUM('active', 'closed'), allowNull: false, defaultValue: 'active' },
    note: { type: DataTypes.TEXT, allowNull: true }
  }, {
    paranoid: true,
    indexes: [
      /* The list screen: one workspace, alphabetical. The default sort must be
         a contiguous run at either end of some index — see test/indices. */
      { fields: ['OrganizationId', 'WorkspaceId', 'name'] },
      { fields: ['OrganizationId', 'MemberId'] },
      { fields: ['UserId'] }
    ]
  });

  return Customer;
};
