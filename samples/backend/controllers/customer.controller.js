/* ══════════════════════════════════════════════════════════════════════════
   Customer — the worked example of a scoped resource.

   Read this next to base.js and crud.js and you have the pattern for every
   other controller:

     • who may see which rows            → `access`, folded into extraFilters
     • who may create, and with what     → beforeCreate / createDefaultAssociations
     • who may change which columns      → readOnlyFields + beforeUpdate
     • what a client may eager-load      → allowedIncludes
     • what the list can be searched by  → searchableFields
     • figures a list shows but does not load → beforeSend
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController, BASE_READ_ONLY } = require('./base');
const scope = require('../services/scope');
const audit = require('../services/audit');
const capabilities = require('../services/capabilities');

module.exports = (db) => {
  const controller = tenantController(db, {
    model: db.Customer,
    workspaceColumn: 'WorkspaceId',

    /* The access model, as an explicit if/else over the role. Every branch
       returns a `where` fragment the client cannot influence — hiding a
       button is a courtesy, this is the enforcement. */
    access: (req) => {
      const u = req.user;
      if (u.user_type === 'admin' || u.user_type === 'agent') return {};
      /* A member sees the customers assigned to them and nobody else's. */
      if (u.user_type === 'member') return { MemberId: u.id };
      /* A portal login sees exactly one row: its own. Note this names the
         primary key, which is also why crud.js's create check can never be
         satisfied by a new row — a customer cannot create a customer. */
      if (u.user_type === 'customer') return { id: u.CustomerId };
      return scope.DENY;
    },

    audit: {
      entity: 'customer',
      createField: audit.FIELD.CUSTOMER,
      fields: {
        name: audit.FIELD.CUSTOMER,
        email: audit.FIELD.EMAIL,
        phone: audit.FIELD.PHONE,
        status: audit.FIELD.STATUS,
        MemberId: audit.FIELD.MEMBER,
        note: audit.FIELD.NOTE
      },
      describe: (row) => ({
        label: row.name,
        WorkspaceId: row.WorkspaceId,
        CustomerId: row.id,
        MemberId: row.MemberId
      })
    }
  });

  /* ── Create ───────────────────────────────────────────────────────────
     `readOnlyFields` does NOT apply to create — the whole body reaches
     Model.create — so anything the client must not set is stripped here.
     To refuse a create, set `req.body.id = -1` and answer from onCreateError.
     ─────────────────────────────────────────────────────────────────────── */

  const audited = { onCreated: controller.onCreated, beforeUpdate: controller.beforeUpdate };

  controller.createDefaultAssociations = async (req) => {
    const u = req.user;
    delete req.body.OrganizationId;
    req.body.OrganizationId = u.OrganizationId;

    /* Never from the body: a portal login could otherwise name itself. */
    delete req.body.UserId;

    if (!capabilities.can(u.user_type, 'customer.create')) {
      req._refusal = { status: 403, body: { error: 'forbidden' } };
      req.body.id = -1;
      return;
    }

    /* A workspace outside the caller's scope is a create into somewhere they
       cannot read back, which crud.js would refuse anyway — but refusing here
       lets us say why. */
    const ids = scope.workspaceIds(req);
    if (ids !== 'all' && !ids.map(String).includes(String(req.body.WorkspaceId))) {
      req._refusal = { status: 422, body: { error: 'workspace_out_of_scope' } };
      req.body.id = -1;
      return;
    }

    if (!String(req.body.name || '').trim()) {
      req._refusal = { status: 422, body: { error: 'name_required' } };
      req.body.id = -1;
    }
  };

  controller.onCreated = audited.onCreated;

  controller.onCreateError = (req, res) => {
    if (req._refusal) return res.status(req._refusal.status).json(req._refusal.body);
    res.status(500).json({ error: 'server_error' });
  };

  /* ── Update ─────────────────────────────────────────────────────────────
     beforeUpdate runs before the write, so it can re-check the rules against
     the proposed row AND read the "from" values the trail needs. Return false
     to refuse; answer first if you want to say why, or crud.js sends a bare
     `{ updated: 0 }`.
     ─────────────────────────────────────────────────────────────────────── */

  controller.beforeUpdate = async (req, res, body, queryFilter) => {
    const u = req.user;

    /* Reassignment changes who can see the record at all, so it is the
       owner's alone. */
    if (body.MemberId !== undefined && u.user_type !== 'admin') {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }

    if (body.name !== undefined && !String(body.name).trim()) {
      res.status(422).json({ error: 'name_required' });
      return false;
    }

    return audited.beforeUpdate(req, res, body, queryFilter);
  };

  /* Closing a record keeps its history; deleting it would orphan the tasks
     and notes that point at it. */
  controller.deleteFilters = async (req) =>
    (req.user.user_type === 'admin' ? {} : scope.DENY);

  /* ── What may be read, and how ──────────────────────────────────────── */

  controller.readOnlyFields = async (req) => {
    const list = BASE_READ_ONLY.concat(['UserId']);
    /* A portal login may correct its own contact details and nothing else. */
    if (req.user.user_type === 'customer') list.push('MemberId', 'WorkspaceId', 'status', 'note');
    return list;
  };

  /* `?include=` is a controller decision, not a client one. hiddenFields masks
     columns on the base model and says nothing about an association, so an
     unvalidated include is a way around every rule on the far side of it —
     `customers?include=Notes` would hand the front desk the restricted model. */
  controller.allowedIncludes = async (req) => {
    if (req.user.user_type === 'agent') return ['Workspace', 'Member'];
    if (req.user.user_type === 'customer') return [];
    return ['Workspace', 'Member', 'Notes'];
  };

  controller.searchableFields = async (req) => {
    if (req.user.user_type === 'customer') return null;
    /* `$Alias.column$` joins a to-one association automatically. Columns
       hiddenFields hides are subtracted, so search can never become an
       existence oracle for something the role may not read. */
    return ['name', 'email', 'phone', '$Workspace.name$'];
  };

  /* ── Figures the list shows but does not load ─────────────────────────
     A screen may only count what its own load fetched. The list shows how
     many open tasks each customer has, over hundreds of rows, and loads no
     tasks at all — so the figure is computed here, in ONE grouped query for
     the whole page, bounded to the ids already scoped.

     beforeSend receives Sequelize instances: assigning a property to one is
     silently lost, because toJSON serialises dataValues and nothing else.
     Use setDataValue.
     ─────────────────────────────────────────────────────────────────────── */

  controller.beforeSend = async (req, res, result) => {
    const rows = Array.isArray(result) ? result : (result ? [result] : []);
    if (!rows.length) return result;

    const counts = await db.Task.findAll({
      where: {
        OrganizationId: req.user.OrganizationId,
        CustomerId: rows.map((r) => r.id),
        status: 'scheduled'
      },
      attributes: ['CustomerId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['CustomerId'],
      raw: true
    });

    const byId = new Map(counts.map((c) => [String(c.CustomerId), Number(c.n)]));
    rows.forEach((row) => row.setDataValue('open_tasks', byId.get(String(row.id)) || 0));
    return result;
  };

  controller.defaultSortingColumn = 'name';
  return controller;
};
