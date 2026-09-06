/* ══════════════════════════════════════════════════════════════════════════
   Derived tables nothing writes directly.

   UserWorkspace is maintained by the staff screens through the User resource;
   it is mounted so a screen can read the assignment without eager-loading
   every workspace on every user, and it is closed to every verb but GET.

   It carries no OrganizationId of its own in some schemas, which is what
   `tenantColumn: false` is for — a scope filter pinning a column that does
   not exist generates invalid SQL, not a tighter filter. Here it does carry
   one, and the flag is left on to show the ordinary case.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController } = require('./base');
const scope = require('../services/scope');

module.exports = (db) => {
  function readOnlyResource(model) {
    const controller = tenantController(db, { model, access: () => ({}) });
    controller.createDefaultAssociations = async (req) => { req.body.id = -1; };
    controller.onCreateError = (req, res) => res.status(403).json({ error: 'forbidden' });
    controller.beforeUpdate = async (req, res) => { res.status(403).json({ error: 'forbidden' }); return false; };
    controller.deleteFilters = async () => scope.DENY;
    return controller;
  }

  return { userWorkspace: readOnlyResource(db.UserWorkspace) };
};
