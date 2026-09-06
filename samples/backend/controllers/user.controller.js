/* ══════════════════════════════════════════════════════════════════════════
   User.

   Two things make this controller different from every other one:

     • `password` never leaves the server, and is never set through CRUD.
       crud.js excludes it from every response, filter and sort on its own;
       this controller also refuses it as an update field, so a password is
       changed through /auth and nowhere else.

     • The role is not editable. Promoting somebody is a different decision
       from correcting their phone number, and letting one PUT do both means
       the audit row says "staff record" when what happened was a privilege
       grant.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController, BASE_READ_ONLY } = require('./base');
const scope = require('../services/scope');
const audit = require('../services/audit');
const capabilities = require('../services/capabilities');

module.exports = (db) => {
  const controller = tenantController(db, {
    model: db.User,

    access: (req) => {
      const u = req.user;
      /* Staff are a directory: everybody inside the organization may see who
         works there. A portal login may not. */
      if (u.user_type === 'customer') return { id: u.id };
      return { user_type: ['admin', 'member', 'agent'] };
    },

    audit: {
      entity: 'staff',
      createField: audit.FIELD.STAFF,
      fields: {
        name: audit.FIELD.STAFF,
        email: audit.FIELD.EMAIL,
        status: audit.FIELD.STATUS,
        all_workspaces: audit.FIELD.ACCESS
      },
      describe: (row) => ({ label: row.name, MemberId: row.id })
    }
  });

  const audited = { beforeUpdate: controller.beforeUpdate };

  controller.createDefaultAssociations = async (req) => {
    const u = req.user;
    delete req.body.OrganizationId;
    req.body.OrganizationId = u.OrganizationId;
    /* An account is created without one and given one through an invite, so
       a create can never smuggle a known password in. */
    delete req.body.password;

    if (!capabilities.can(u.user_type, 'staff.create')) {
      req._refusal = { status: 403, body: { error: 'forbidden' } };
      req.body.id = -1;
      return;
    }
    if (!['member', 'agent'].includes(req.body.user_type)) {
      req._refusal = { status: 422, body: { error: 'invalid_role' } };
      req.body.id = -1;
    }
  };

  controller.onCreateError = (req, res) => {
    if (req._refusal) return res.status(req._refusal.status).json(req._refusal.body);
    if (req._refusal === undefined) return res.status(409).json({ error: 'email_taken' });
    res.status(500).json({ error: 'server_error' });
  };

  controller.beforeUpdate = async (req, res, body, queryFilter) => {
    const u = req.user;
    const fields = Object.keys(body);
    const renameOnly = fields.length === 1 && fields[0] === 'name';

    if (!capabilities.can(u.user_type, 'staff.create') &&
        !(renameOnly && capabilities.can(u.user_type, 'staff.rename')) &&
        String(u.id) !== String(queryFilter.id)) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }

    /* Deactivating somebody stops them signing in and is not a rename. */
    if (body.status !== undefined && !capabilities.can(u.user_type, 'staff.deactivate')) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return audited.beforeUpdate(req, res, body, queryFilter);
  };

  /* Removing an account would orphan everything it authored. Deactivate. */
  controller.deleteFilters = async () => scope.DENY;

  /* Belt to crud.js's braces: it already strips `password` from every
     response, but it must also be unsettable here. */
  controller.readOnlyFields = async () =>
    BASE_READ_ONLY.concat(['password', 'user_type', 'email']);

  controller.hiddenFields = async () => ['password'];
  controller.allowedIncludes = async () => ['Workspaces'];
  controller.searchableFields = async () => ['name', 'email'];
  controller.defaultSortingColumn = 'name';
  return controller;
};
