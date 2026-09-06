/* Refresh, invite and reset tokens.

   Only the SHA-256 is stored. A database dump is then not a pile of working
   links, and a token that leaks from a log is still not a token that can be
   presented. services/passwords.js mints and hashes them. */
'use strict';

module.exports = (sequelize, DataTypes) => {
  const AuthToken = sequelize.define('AuthToken', {
    UserId: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.ENUM('refresh', 'invite', 'reset', 'verify'), allowNull: false },
    token_hash: { type: DataTypes.STRING(64), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    used_at: { type: DataTypes.DATE, allowNull: true }
  }, {
    paranoid: false,
    indexes: [
      { fields: ['token_hash'], unique: true },
      { fields: ['UserId', 'kind'] },
      { fields: ['expires_at'] }
    ]
  });

  return AuthToken;
};
