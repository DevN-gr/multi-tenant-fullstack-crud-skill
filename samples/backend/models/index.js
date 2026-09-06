/* ══════════════════════════════════════════════════════════════════════════
   Sequelize bootstrap: connection, models, associations, schema and seeding.

   No migrations. The schema is applied on boot with `sync()`, dropped and
   rebuilt in development so a changed column is one restart away.

   Dialects: SQLite for development and tests, MySQL for qa and production.
   SQLite is a devDependency, so a production image never installs its native
   build chain — production cannot run on SQLite by construction, which is
   the intent rather than an accident.

   The schema work lives in `db.init()`, which bin/www awaits before it
   listens and the test suite awaits before it asserts. Doing it in a
   top-level IIFE at require time would mean nothing can await it and the
   first request races the CREATE TABLE.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes, Op } = require('sequelize');
const c = require('../config-dir');
const logger = require('../utils/logger');

const ENVIRONMENT = process.env.NODE_ENV || 'development';

const sqlLogger = c.get('db_logging') ? (sql) => logger.debug(sql) : false;

const DB_CONFIG = {
  development: {
    dialect: 'sqlite',
    storage: path.join(__dirname, '..', 'db', 'development.sqlite'),
    logging: sqlLogger,
    /* One connection, never recycled: SQLite serialises writes anyway, and a
       pool would only manufacture SQLITE_BUSY. The corollary is that anything
       querying from inside a transaction must be handed that transaction, or
       it waits for a connection the transaction is holding — for ever. */
    pool: { max: 1, idle: Infinity, maxUses: Infinity }
  },
  test: {
    dialect: 'sqlite',
    storage: ':memory:',
    logging: sqlLogger,
    pool: { max: 1, idle: Infinity, maxUses: Infinity }
  },
  qa: {
    dialect: 'mysql',
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT) || 3306,
    database: process.env.MYSQL_DATABASE,
    username: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    logging: sqlLogger,
    pool: { max: 10, min: 0, acquire: 60000, idle: 10000 }
  },
  production: {
    dialect: 'mysql',
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT) || 3306,
    database: process.env.MYSQL_DATABASE,
    username: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    logging: sqlLogger,
    pool: { max: 10, min: 0, acquire: 60000, idle: 10000 }
  }
};

const settings = DB_CONFIG[ENVIRONMENT];
if (!settings) throw new Error(`No database configuration for NODE_ENV="${ENVIRONMENT}"`);

/* SQLite writes to a file it will not create the directory for. */
if (settings.dialect === 'sqlite' && settings.storage !== ':memory:') {
  fs.mkdirSync(path.dirname(settings.storage), { recursive: true });
}

const sequelize = new Sequelize(settings);

const db = {};
db.Sequelize = Sequelize;
db.DataTypes = DataTypes;
db.Op = Op;
db.sequelize = sequelize;
db.ENVIRONMENT = ENVIRONMENT;

/* ── Models ─────────────────────────────────────────────────────────────── */

db.Organization = require('./organization.model')(sequelize, DataTypes, db);
db.User = require('./user.model')(sequelize, DataTypes, db);
db.Workspace = require('./workspace.model')(sequelize, DataTypes, db);
db.UserWorkspace = require('./user_workspace.model')(sequelize, DataTypes, db);
db.AuthToken = require('./auth_token.model')(sequelize, DataTypes, db);
db.Customer = require('./customer.model')(sequelize, DataTypes, db);
db.Task = require('./task.model')(sequelize, DataTypes, db);
db.Note = require('./note.model')(sequelize, DataTypes, db);
db.AuditEntry = require('./audit_entry.model')(sequelize, DataTypes, db);

/* ── Associations ───────────────────────────────────────────────────────────
   Every tenant-scoped model belongs to an Organization. That association is
   what `?include=Organization` reads; the OrganizationId *column* is what
   every controller's extraFilters pins, because a scope filter that needs a
   join is a scope filter somebody will forget.
   ───────────────────────────────────────────────────────────────────────── */

const TENANT_SCOPED = [
  'User', 'Workspace', 'UserWorkspace', 'Customer', 'Task', 'Note', 'AuditEntry'
];

TENANT_SCOPED.forEach((name) => {
  db[name].belongsTo(db.Organization, { foreignKey: 'OrganizationId' });
  db.Organization.hasMany(db[name], { foreignKey: 'OrganizationId', as: name + 's' });
});
db.TENANT_SCOPED = TENANT_SCOPED;

/* Staff ↔ workspaces, through the explicit join so the scope is indexable. */
db.User.belongsToMany(db.Workspace, { through: db.UserWorkspace, as: 'Workspaces', foreignKey: 'UserId', otherKey: 'WorkspaceId' });
db.Workspace.belongsToMany(db.User, { through: db.UserWorkspace, as: 'Staff', foreignKey: 'WorkspaceId', otherKey: 'UserId' });
db.UserWorkspace.belongsTo(db.User, { foreignKey: 'UserId' });
db.UserWorkspace.belongsTo(db.Workspace, { foreignKey: 'WorkspaceId' });
db.User.hasMany(db.UserWorkspace, { foreignKey: 'UserId', as: 'UserWorkspaces' });
db.Workspace.hasMany(db.UserWorkspace, { foreignKey: 'WorkspaceId', as: 'UserWorkspaces' });

db.AuthToken.belongsTo(db.User, { foreignKey: 'UserId' });
db.User.hasMany(db.AuthToken, { foreignKey: 'UserId', as: 'AuthTokens' });

db.Customer.belongsTo(db.Workspace, { foreignKey: 'WorkspaceId' });
db.Workspace.hasMany(db.Customer, { foreignKey: 'WorkspaceId', as: 'Customers' });
db.Customer.belongsTo(db.User, { foreignKey: 'MemberId', as: 'Member' });
db.User.hasMany(db.Customer, { foreignKey: 'MemberId', as: 'AssignedCustomers' });
/* The portal login, when one has been invited. */
db.Customer.belongsTo(db.User, { foreignKey: 'UserId', as: 'Account' });
db.User.hasOne(db.Customer, { foreignKey: 'UserId', as: 'CustomerRecord' });

db.Task.belongsTo(db.Customer, { foreignKey: 'CustomerId' });
db.Customer.hasMany(db.Task, { foreignKey: 'CustomerId', as: 'Tasks' });
db.Task.belongsTo(db.Workspace, { foreignKey: 'WorkspaceId' });
db.Workspace.hasMany(db.Task, { foreignKey: 'WorkspaceId', as: 'Tasks' });
db.Task.belongsTo(db.User, { foreignKey: 'MemberId', as: 'Member' });
db.User.hasMany(db.Task, { foreignKey: 'MemberId', as: 'Tasks' });

db.Note.belongsTo(db.Customer, { foreignKey: 'CustomerId' });
db.Customer.hasMany(db.Note, { foreignKey: 'CustomerId', as: 'Notes' });
db.Note.belongsTo(db.User, { foreignKey: 'MemberId', as: 'Member' });

db.AuditEntry.belongsTo(db.User, { foreignKey: 'UserId' });
db.AuditEntry.belongsTo(db.Workspace, { foreignKey: 'WorkspaceId' });
db.AuditEntry.belongsTo(db.Customer, { foreignKey: 'CustomerId' });

/* ── Boot ───────────────────────────────────────────────────────────────── */

let initPromise = null;

/**
 * The one thing `sync({ alter })` will not do.
 *
 * It adds columns and it changes types, but it leaves an existing column's
 * NOT NULL alone — so a model that starts allowing null goes on refusing it
 * everywhere the table already existed. That is not theoretical: making
 * `User.email` nullable works on every fresh database and fails on every
 * deployed one, and no test can see it because the tests rebuild their schema
 * from nothing.
 *
 * Only ever in the loosening direction. Tightening a column that already
 * holds nulls would fail mid-boot, and a schema fix that stops the server
 * starting is worse than the drift it was correcting.
 *
 * This is not a migration system and not the beginning of one. It is one
 * reconciliation for one thing `sync` documents itself as not doing.
 */
async function relaxNullability() {
  /* SQLite cannot ALTER a column at all, and never needs to: it is rebuilt
     from nothing in the two environments that use it. */
  if (settings.dialect !== 'mysql') return;

  const queryInterface = sequelize.getQueryInterface();
  const relaxed = [];

  for (const name of Object.keys(db)) {
    const model = db[name];
    if (!model || typeof model.getTableName !== 'function') continue;

    let described;
    try { described = await queryInterface.describeTable(model.getTableName()); }
    catch (err) { continue; }                    // the table is not there yet

    for (const [column, attribute] of Object.entries(model.rawAttributes)) {
      const field = attribute.field || column;
      const live = described[field];
      if (!live) continue;
      if (attribute.allowNull !== true) continue;
      if (live.allowNull !== false) continue;

      /* Built from the model, so the type and default come out right. The
         unique flag is dropped: it is already an index, and asking for it
         again asks for a second one. */
      const { unique, primaryKey, ...definition } = attribute;
      await queryInterface.changeColumn(model.getTableName(), field, definition);
      relaxed.push(`${model.getTableName()}.${field}`);
    }
  }

  if (relaxed.length) {
    logger.warn({ columns: relaxed }, 'Relaxed NOT NULL that sync({alter}) left in place');
  }
}

/**
 * Apply the schema and, on an empty database, put somebody in it who can
 * create the first organization. Idempotent: repeated calls return the same
 * promise, so requiring this module twice does not sync twice.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - drop and rebuild. Defaults to true in
 *   development and test, and is refused outright anywhere else.
 */
db.init = function init(opts = {}) {
  if (initPromise) return initPromise;

  const rebuildable = ENVIRONMENT === 'development' || ENVIRONMENT === 'test';
  const force = opts.force === undefined ? rebuildable : opts.force;
  if (force && !rebuildable) {
    throw new Error(`Refusing to force-sync the schema in NODE_ENV="${ENVIRONMENT}"`);
  }

  initPromise = (async () => {
    await sequelize.authenticate();
    await sequelize.sync(force ? { force: true } : { alter: { drop: false } });
    if (!force) await relaxNullability();
    logger.info({ dialect: settings.dialect, force }, 'Schema applied');

    if (opts.seed !== false) await require('../seed/bootstrap')(db);

    return db;
  })();

  return initPromise;
};

/** Drop the connection. Tests call this; the server never does. */
db.close = async function close() {
  initPromise = null;
  await sequelize.close();
};

module.exports = db;
