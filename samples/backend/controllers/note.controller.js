/* ══════════════════════════════════════════════════════════════════════════
   Note — the restricted resource.

   The front desk is refused this model outright, and the refusal is an empty
   result rather than a 403: asking for a note by id must return exactly what
   asking for one that does not exist returns, or the endpoint becomes an
   oracle for whether a given record has one.

   That is the whole reason `scope.DENY` is `{ id: -1 }` — a condition that
   matches nothing — rather than a thrown error.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const { tenantController, BASE_READ_ONLY } = require('./base');
const scope = require('../services/scope');
const audit = require('../services/audit');

module.exports = (db) => {
  const controller = tenantController(db, {
    model: db.Note,

    access: (req) => {
      const u = req.user;
      if (u.user_type === 'admin') return {};
      /* A member reads and writes their own notes. */
      if (u.user_type === 'member') return { MemberId: u.id };
      /* A portal login reads the notes shared with it, and writes none. */
      if (u.user_type === 'customer') return { CustomerId: u.CustomerId, shared: true };
      /* Everybody else — the front desk included — sees nothing at all. */
      return scope.DENY;
    },

    audit: {
      entity: 'note',
      createField: audit.FIELD.NOTE,
      fields: { body: audit.FIELD.NOTE, shared: audit.FIELD.ACCESS },
      describe: (row) => ({
        label: `Note ${row.date}`,
        CustomerId: row.CustomerId,
        MemberId: row.MemberId
      }),
      /* Never put the note's text in the trail: the audit log is readable by
         a role the note is not. Log that it changed, not what it says. */
      render: (column, raw) => (column === 'body' ? 'edited' : raw)
    },

    beforeCreate: async (req) => {
      /* The author is the caller, always. A body naming somebody else would
         be a note filed under a colleague. */
      req.body.MemberId = req.user.id;
    }
  });

  controller.readOnlyFields = async () => BASE_READ_ONLY.concat(['MemberId', 'CustomerId']);
  controller.allowedIncludes = async () => [];
  controller.searchableFields = async () => null;
  controller.defaultSortingColumn = 'date';
  controller.defaultSortingDirection = 'DESC';
  return controller;
};
