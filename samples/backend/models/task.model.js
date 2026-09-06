/* A unit of work against a customer. Dates are "YYYY-MM-DD" strings and times
   are "HH:MM" strings, never Date objects: a timezone must never reach a
   scheduling decision, and both sort correctly as text. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const Task = sequelize.define('Task', {
    OrganizationId: { type: DataTypes.INTEGER, allowNull: false },
    WorkspaceId: { type: DataTypes.INTEGER, allowNull: false },
    CustomerId: { type: DataTypes.INTEGER, allowNull: false },
    MemberId: { type: DataTypes.INTEGER, allowNull: false },

    date: { type: DataTypes.STRING(10), allowNull: false },   // YYYY-MM-DD
    start: { type: DataTypes.STRING(5), allowNull: false },   // HH:MM
    duration: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },

    status: {
      type: DataTypes.ENUM('scheduled', 'done', 'cancelled', 'missed'),
      allowNull: false, defaultValue: 'scheduled'
    },
    title: { type: DataTypes.STRING, allowNull: false },
    price: { type: DataTypes.FLOAT, allowNull: true }
  }, {
    paranoid: true,
    indexes: [
      /* The day view, and the overlap check the rules engine runs. */
      { fields: ['OrganizationId', 'date', 'start'] },
      { fields: ['OrganizationId', 'MemberId', 'date'] },
      { fields: ['OrganizationId', 'CustomerId', 'date'] }
    ]
  });

  return Task;
};
