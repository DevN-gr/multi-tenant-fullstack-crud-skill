/* ══════════════════════════════════════════════════════════════════════════
   Capabilities per user type — the single authority.

   The browser answers `can()` from this table, but the table arrives from
   GET /auth/me rather than being written out a second time in the frontend,
   so there is one definition rather than two that can disagree. Hiding a
   button remains a courtesy; the controllers' extraFilters are the
   enforcement.

   The omissions are the product, and each one should be deliberate:

     • `agent` never gets `note.*`. The front desk cannot read the private
       notes — including indirectly, through `?include=` or the audit log.
     • `member` never gets `finance.view`. Somebody who does the work sees
       their own figures, not the organization's books.
     • `superadmin` gets **no tenant data capability at all**. It creates
       owners and manages organizations; it cannot read a customer record.
       A platform operator has no business in tenant data, and the only way
       to guarantee that is to not grant it. Support that needs data goes
       through the owner.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const CAPS = {
  /* The platform. Deliberately narrow — see the header. */
  superadmin: ['org.view', 'org.create', 'org.manage', 'staff.invite.owner'],

  /* The organization's owner. Everything inside their own tenant. */
  admin: ['*'],

  member: [
    'task.view.own', 'task.edit.own', 'task.create',
    'customer.view.own', 'note.view', 'note.edit',
    'earnings.view.own', 'reports.view.own', 'workspace.view', 'staff.view'
  ],

  agent: [
    'task.view.all', 'task.edit.all', 'task.create',
    'customer.view.all', 'customer.create', 'customer.edit',
    'finance.view', 'finance.edit',
    'reports.view.all', 'workspace.view', 'staff.view', 'audit.view',
    /* Correcting a name is not the decision that creating the thing was, so
       the rename capabilities are named separately and the controllers hold
       them to the name column alone. */
    'staff.rename', 'workspace.rename'
  ],

  customer: ['portal.view', 'task.request', 'task.cancel.own', 'note.view.own']
};

/** Every capability an admin's `*` stands for, so /auth/me can send a list
    rather than a wildcard the client would have to interpret. */
const ALL = [...new Set(
  Object.keys(CAPS)
    .filter((role) => role !== 'admin' && role !== 'superadmin')
    .flatMap((role) => CAPS[role])
    .concat([
      /* Owner-only. Each of these changes what the organization *is*, which
         is why none of them belongs to the front desk. */
      'workspace.create', 'staff.create', 'staff.invite', 'staff.deactivate',
      'audit.view', 'settings.manage',
      'data.export', 'data.import', 'data.wipe'
    ])
)].sort();

function can(user_type, cap) {
  const list = CAPS[user_type] || [];
  return list.includes('*') || list.includes(cap);
}

/** The capability list for a user type, wildcard expanded. */
function listFor(user_type) {
  const list = CAPS[user_type] || [];
  return list.includes('*') ? ALL.slice() : list.slice();
}

module.exports = { CAPS, ALL, can, listFor };
