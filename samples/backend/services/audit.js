/* ══════════════════════════════════════════════════════════════════════════
   The audit trail, and the hooks that make it automatic.

   One row per changed field: who, when, which field, from what value, to
   what value, plus the record it belongs to.

   The mechanism is `logChanges`, and the reason it hangs off crud.js's
   `beforeUpdate` hook is that beforeUpdate runs *before* the write — the
   "from" values are still readable. Anything logging afterwards could only
   record what a field became, never what it was.

   Two rules the writers must not have to remember, so they are enforced here:

     • Unchanged fields are dropped. Saving a form without editing it logs
       nothing, so pass the whole field list and let this filter it.
     • Values are the strings the interface showed. The log is a record of
       what a person saw and changed, not of column types.

   `auditHooks` composes the whole thing into a controller: create, update and
   delete are covered without each controller restating it.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/**
 * The vocabulary the log can record. A table rather than free strings,
 * because the filter dropdown, the seed and the tests all read this one list
 * — a stray label would be a filter option that matches one row for ever.
 *
 * In a localised product these are the display strings, in the interface's
 * language. Everything else in this file stays English.
 */
const FIELD = {
  CUSTOMER: 'Customer',
  WORKSPACE: 'Workspace',
  STAFF: 'Staff record',
  TASK: 'Task',
  DATE: 'Date',
  START: 'Time',
  DURATION: 'Duration',
  MEMBER: 'Assignee',
  STATUS: 'Status',
  PRICE: 'Price',
  TITLE: 'Title',
  NOTE: 'Note',
  EMAIL: 'E-mail',
  PHONE: 'Phone',
  ACCESS: 'Access',
  ORGANIZATION: 'Organization'
};

/** Entities an entry can point at; drives the "open the record" click. */
const ENTITY_LABEL = {
  customer: 'Customer',
  task: 'Task',
  note: 'Note',
  workspace: 'Workspace',
  staff: 'Staff',
  session: 'Account',
  organization: 'Organization'
};

/** Fields that describe the restricted model. Withheld from roles without
    `note.view`, so the log cannot leak what the record itself locks. */
const RESTRICTED_FIELDS = [FIELD.NOTE];

/** Entities that are restricted, whatever field they name. */
const RESTRICTED_ENTITIES = ['note'];

/** Render a value the way the interface showed it. */
function value(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return String(v);
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Append entries. Rows whose `from` equals `to` are dropped automatically, so
 * callers pass the whole field list rather than working out what moved.
 *
 * @param {object} db
 * @param {object} req      - for the actor; may be null for system actions
 * @param {object} ctx      - { entity, entityId, label, WorkspaceId,
 *                              CustomerId, MemberId, action, OrganizationId }
 * @param {Array}  changes  - [{ field, from, to }]
 * @param {object} [options] - { transaction } when the caller is inside one.
 *   Not optional in practice: a write on its own connection while a
 *   transaction holds the only one in the pool deadlocks, and SQLite's pool
 *   is deliberately one connection deep.
 */
async function logChanges(db, req, ctx, changes, options = {}) {
  const actor = req && req.user
    ? { id: req.user.id, name: req.user.name, role: req.user.user_type }
    : { id: null, name: 'System', role: 'system' };

  const now = new Date();

  const rows = [];
  changes.forEach((change) => {
    const from = value(change.from);
    const to = value(change.to);
    if (from === to) return;
    rows.push({
      OrganizationId: ctx.OrganizationId || (req && req.user && req.user.OrganizationId) || null,
      date: ymd(now),
      time: hm(now),
      UserId: actor.id,
      user_name: actor.name,
      user_role: actor.role,
      entity: ctx.entity,
      entity_id: ctx.entityId || null,
      label: ctx.label || null,
      WorkspaceId: ctx.WorkspaceId || null,
      CustomerId: ctx.CustomerId || null,
      MemberId: ctx.MemberId || null,
      action: ctx.action || 'update',
      field: change.field,
      from_value: from,
      to_value: to
    });
  });

  if (!rows.length) return [];
  const created = await db.AuditEntry.bulkCreate(rows, { transaction: options.transaction });
  await trim(db, rows[0].OrganizationId, options.transaction);
  return created;
}

/** Keep the trail bounded per organization. */
async function trim(db, OrganizationId, transaction) {
  if (!OrganizationId) return;
  const total = await db.AuditEntry.count({ where: { OrganizationId }, transaction });
  if (total <= db.AuditEntry.LIMIT) return;

  const doomed = await db.AuditEntry.findAll({
    where: { OrganizationId },
    order: [['date', 'ASC'], ['time', 'ASC'], ['id', 'ASC']],
    limit: total - db.AuditEntry.LIMIT,
    attributes: ['id'],
    raw: true,
    transaction
  });
  await db.AuditEntry.destroy({ where: { id: doomed.map((r) => r.id) }, transaction });
}

/**
 * Compose the trail into a controller.
 *
 * Returns hook implementations the controller spreads over its own. Each
 * takes a `describe(row)` that turns a model row into the log's context —
 * which entity it is, what to call it, and which scope it belongs to — plus a
 * `fields` map naming the columns worth recording.
 *
 * @param {object} db
 * @param {object} spec
 * @param {object} spec.model      - the Sequelize model
 * @param {string} spec.entity     - key in ENTITY_LABEL
 * @param {object} spec.fields     - { columnName: FIELD.LABEL }
 * @param {function} spec.describe - (row) => { label, WorkspaceId, CustomerId, MemberId }
 * @param {function} [spec.render] - (column, rawValue, row) => displayable
 */
function auditHooks(db, spec) {
  const columns = Object.keys(spec.fields);
  const describe = spec.describe || (() => ({}));
  const render = spec.render || ((column, raw) => raw);

  async function context(req, row, action) {
    const extra = await describe(row, db, req);
    return {
      entity: spec.entity,
      entityId: row.id,
      action,
      OrganizationId: row.OrganizationId || (req.user && req.user.OrganizationId),
      ...extra
    };
  }

  return {
    /** A creation is one row, with `—` on the empty side. */
    async onCreated(req, res, row) {
      await logChanges(db, req, await context(req, row, 'create'), [{
        field: spec.createField || spec.fields[columns[0]],
        from: null,
        to: (await describe(row, db, req)).label || String(row.id)
      }]);
    },

    /**
     * The seam that makes field-level logging possible: this runs before the
     * UPDATE, so both sides of every change are still readable.
     */
    async beforeUpdate(req, res, body, queryFilter) {
      const before = await spec.model.findOne({ where: queryFilter });
      if (!before) return true;            // nothing matched; crud reports 0

      const changes = columns
        .filter((column) => Object.prototype.hasOwnProperty.call(body, column))
        .map((column) => ({
          field: spec.fields[column],
          from: render(column, before[column], before),
          to: render(column, body[column], before)
        }));

      if (changes.length) {
        await logChanges(db, req, await context(req, before, 'update'), changes);
      }
      return true;
    },

    async afterDelete(req, res, queryFilter, deleted) {
      if (!deleted) return;
      const row = await spec.model.findOne({ where: queryFilter, paranoid: false });
      if (!row) return;
      await logChanges(db, req, await context(req, row, 'delete'), [{
        field: spec.createField || spec.fields[columns[0]],
        from: (await describe(row, db, req)).label || String(row.id),
        to: null
      }]);
    }
  };
}

module.exports = {
  FIELD, ENTITY_LABEL, RESTRICTED_FIELDS, RESTRICTED_ENTITIES,
  logChanges, auditHooks, value, trim
};
