/* ══════════════════════════════════════════════════════════════════════════
   AuditEntry — read-only, and the place an access model most often leaks.

   The trail names every field that changed on every record, which means a
   role refused the restricted model must be refused its audit rows too. That
   is not an extra rule so much as the same rule, applied to a second copy of
   the data — and it is exactly the copy people forget.

   Nothing writes here through the API. Entries are written by
   services/audit.js from inside the hooks of the controller that made the
   change, which is what makes the trail an account of what happened rather
   than of what a client claimed.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController } = require('./base');
const scope = require('../services/scope');
const audit = require('../services/audit');
const capabilities = require('../services/capabilities');

module.exports = (db) => {
  const controller = tenantController(db, {
    model: db.AuditEntry,

    access: (req) => {
      const u = req.user;
      if (!capabilities.can(u.user_type, 'audit.view')) {
        /* A member sees the trail of their own work; anybody else without
           the capability sees none of it. */
        if (u.user_type === 'member') {
          return { MemberId: u.id, field: { [db.Op.notIn]: audit.RESTRICTED_FIELDS } };
        }
        return scope.DENY;
      }

      /* Has the capability, but may not read the restricted model: subtract
         its entries rather than handing them over in a different shape. */
      if (!capabilities.can(u.user_type, 'note.view')) {
        return {
          entity: { [db.Op.notIn]: audit.RESTRICTED_ENTITIES },
          field: { [db.Op.notIn]: audit.RESTRICTED_FIELDS }
        };
      }
      return {};
    }
  });

  /* Nothing creates, updates or deletes a trail entry from outside. */
  controller.createDefaultAssociations = async (req) => { req.body.id = -1; };
  controller.onCreateError = (req, res) => res.status(403).json({ error: 'forbidden' });
  controller.beforeUpdate = async (req, res) => { res.status(403).json({ error: 'forbidden' }); return false; };
  controller.deleteFilters = async () => scope.DENY;

  controller.searchableFields = async () => ['label', 'user_name', 'field'];
  controller.defaultSortingColumn = ['date', 'time'];
  controller.defaultSortingDirection = 'DESC';
  return controller;
};
