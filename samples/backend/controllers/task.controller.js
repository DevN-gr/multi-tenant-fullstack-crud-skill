/* ══════════════════════════════════════════════════════════════════════════
   Task — where the domain rules live.

   There are no action routes. Creating, moving, reassigning, completing and
   cancelling are all one POST and one PUT, told apart by what the body
   carries. That is deliberate: `POST /tasks/:id/cancel` would be a second
   authorization surface, and the one that gets forgotten.

   The rules themselves live in `shared/rules.js`, which the browser loads and
   the server require()s — one implementation, so the instant feedback while
   somebody types and the refusal that actually counts cannot disagree. The
   server runs them regardless of what the client claims to have checked.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController, BASE_READ_ONLY } = require('./base');
const scope = require('../services/scope');
const audit = require('../services/audit');
const { Rules } = require('../shared');

module.exports = (db) => {
  const controller = tenantController(db, {
    model: db.Task,
    workspaceColumn: 'WorkspaceId',

    access: (req) => {
      const u = req.user;
      if (u.user_type === 'admin' || u.user_type === 'agent') return {};
      if (u.user_type === 'member') return { MemberId: u.id };
      if (u.user_type === 'customer') return { CustomerId: u.CustomerId };
      return scope.DENY;
    },

    audit: {
      entity: 'task',
      createField: audit.FIELD.TASK,
      fields: {
        date: audit.FIELD.DATE,
        start: audit.FIELD.START,
        duration: audit.FIELD.DURATION,
        MemberId: audit.FIELD.MEMBER,
        status: audit.FIELD.STATUS,
        price: audit.FIELD.PRICE,
        title: audit.FIELD.TITLE
      },
      describe: (row) => ({
        label: `${row.date} ${row.start}`,
        WorkspaceId: row.WorkspaceId,
        CustomerId: row.CustomerId,
        MemberId: row.MemberId
      })
    }
  });

  /**
   * The slice the rules need, read for the dates being judged.
   *
   * Resolved BEFORE any transaction opens. Anything that queries from inside
   * a transaction must be handed that transaction, or on SQLite — whose pool
   * is one connection deep — it waits for a connection the transaction is
   * holding, for ever, with no error.
   */
  async function context(OrganizationId, dates) {
    const tasks = await db.Task.findAll({
      where: { OrganizationId, date: dates, status: ['scheduled', 'done'] },
      raw: true
    });
    return { tasks };
  }

  const audited = { beforeUpdate: controller.beforeUpdate };

  controller.createDefaultAssociations = async (req) => {
    const u = req.user;
    delete req.body.OrganizationId;
    req.body.OrganizationId = u.OrganizationId;

    /* A portal login may request work but never book it outright. */
    if (u.user_type === 'customer') {
      req._refusal = { status: 403, body: { error: 'forbidden' } };
      req.body.id = -1;
      return;
    }

    /* crud.js has already coerced the body to the model's declared types.
       That is load-bearing rather than tidy: the rules compare the body to
       rows already loaded, in JavaScript, and `7 === "7"` is false — an
       uncoerced id walks straight past a clash check. Do not convert again. */
    const clash = Rules.firstClash(req.body, await context(u.OrganizationId, [req.body.date]));
    if (clash) {
      req._refusal = { status: 422, body: { error: clash.code, detail: clash.detail } };
      req.body.id = -1;
    }
  };

  controller.onCreateError = (req, res) => {
    if (req._refusal) return res.status(req._refusal.status).json(req._refusal.body);
    res.status(500).json({ error: 'server_error' });
  };

  controller.beforeUpdate = async (req, res, body, queryFilter) => {
    const u = req.user;
    const before = await db.Task.findOne({ where: queryFilter });
    if (!before) return true;                    // nothing matched; crud reports 0

    /* A portal login may cancel its own, and change nothing else. */
    if (u.user_type === 'customer') {
      const only = Object.keys(body).length === 1 && body.status === 'cancelled';
      if (!only) { res.status(403).json({ error: 'forbidden' }); return false; }
    }

    /* Re-check the rules against the proposed row — the merge of what is
       stored and what is being sent — not against the body alone. */
    if (body.date || body.start || body.duration || body.MemberId) {
      const proposed = { ...before.get({ plain: true, clone: true }), ...body };
      const clash = Rules.firstClash(proposed, await context(u.OrganizationId, [proposed.date]));
      if (clash) { res.status(422).json({ error: clash.code, detail: clash.detail }); return false; }
    }

    return audited.beforeUpdate(req, res, body, queryFilter);
  };

  controller.readOnlyFields = async (req) => {
    const list = BASE_READ_ONLY.concat(['CustomerId']);
    if (req.user.user_type === 'member') list.push('price');
    return list;
  };

  controller.allowedIncludes = async () => ['Customer', 'Member', 'Workspace'];
  controller.searchableFields = async () => ['title', '$Customer.name$'];
  controller.defaultSortingColumn = ['date', 'start'];
  controller.defaultSortingDirection = 'ASC';
  return controller;
};
