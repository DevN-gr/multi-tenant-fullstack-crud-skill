/* ══════════════════════════════════════════════════════════════════════════
   Workspace.

   Opening one changes what the whole organization is, so `workspace.create`
   is the owner's alone — while correcting a name is the front desk's, which
   is why `workspace.rename` exists separately and reaches the name column and
   nothing beside it. A body carrying an address as well is refused rather
   than half applied: a request that saves some of what somebody typed is
   worse than one that saves none of it.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController, BASE_READ_ONLY } = require('./base');
const scope = require('../services/scope');
const audit = require('../services/audit');
const capabilities = require('../services/capabilities');

/** How many workspaces the product is scoped to run. */
const MAX_WORKSPACES = 20;

module.exports = (db) => {
  const controller = tenantController(db, {
    model: db.Workspace,

    /* Everyone inside the organization may see the workspaces — the list is
       how a screen names a place. WHICH workspace's data they reach is a
       separate question, answered by every other controller's scope. */
    access: () => ({}),

    audit: {
      entity: 'workspace',
      createField: audit.FIELD.WORKSPACE,
      fields: {
        name: audit.FIELD.WORKSPACE,
        address: audit.FIELD.WORKSPACE,
        city: audit.FIELD.WORKSPACE
      },
      describe: (row) => ({ label: row.name, WorkspaceId: row.id })
    }
  });

  const audited = { beforeUpdate: controller.beforeUpdate };

  controller.createDefaultAssociations = async (req) => {
    const u = req.user;
    delete req.body.OrganizationId;
    req.body.OrganizationId = u.OrganizationId;

    if (!capabilities.can(u.user_type, 'workspace.create')) {
      req._refusal = { status: 403, body: { error: 'forbidden' } };
      req.body.id = -1;
      return;
    }
    const count = await db.Workspace.count({ where: { OrganizationId: u.OrganizationId } });
    if (count >= MAX_WORKSPACES) {
      req._refusal = { status: 422, body: { error: 'workspace_limit', limit: MAX_WORKSPACES } };
      req.body.id = -1;
    }
  };

  controller.onCreateError = (req, res) => {
    if (req._refusal) return res.status(req._refusal.status).json(req._refusal.body);
    res.status(500).json({ error: 'server_error' });
  };

  controller.beforeUpdate = async (req, res, body, queryFilter) => {
    const u = req.user;
    const fields = Object.keys(body);
    const renameOnly = fields.length === 1 && fields[0] === 'name';

    if (fields.length &&
        !capabilities.can(u.user_type, 'workspace.create') &&
        !(renameOnly && capabilities.can(u.user_type, 'workspace.rename'))) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    if (body.name !== undefined && !String(body.name).trim()) {
      res.status(422).json({ error: 'name_required' });
      return false;
    }
    return audited.beforeUpdate(req, res, body, queryFilter);
  };

  /* Closing a workspace would orphan its staff, customers and history. */
  controller.deleteFilters = async () => scope.DENY;

  controller.readOnlyFields = async () => BASE_READ_ONLY.concat(['code']);
  controller.searchableFields = async () => ['name', 'city', 'address', 'code'];
  controller.defaultSortingColumn = 'name';

  controller.MAX_WORKSPACES = MAX_WORKSPACES;
  return controller;
};
