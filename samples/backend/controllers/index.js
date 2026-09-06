/* ══════════════════════════════════════════════════════════════════════════
   Every controller, assembled once.

   Read this next to the RESOURCES list in app.js and you have the whole API
   surface: one row per resource, no hand-written CRUD, and the behaviour that
   makes each one correct living in its own controller's hooks.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

module.exports = (db) => ({
  organization: require('./organization.controller')(db),
  user: require('./user.controller')(db),
  workspace: require('./workspace.controller')(db),
  userWorkspace: require('./readonly.controller')(db).userWorkspace,
  customer: require('./customer.controller')(db),
  task: require('./task.controller')(db),
  note: require('./note.controller')(db),
  auditEntry: require('./audit_entry.controller')(db)
});
