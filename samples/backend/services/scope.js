/* ══════════════════════════════════════════════════════════════════════════
   Scope — the conditions every controller's extraFilters is built from.

   Two boundaries, applied in this order:

     1. The tenant. Every query is pinned to req.user.OrganizationId. This is
        not negotiable and not per-role: a the front deskist and an owner are both
        confined to their own organization, and a superadmin has no tenant
        data capability at all.

     2. The workspace scope. Inside an organization, staff may be network-wide
        (all_workspaces) or attached to named practices, which is what stops
        the front desk at one site reading another's day.

   `DENY` is the framework's refusal: an id that cannot exist, so the query
   runs and returns nothing. That matters more than a 403 — a the front deskist
   asking for a private record by id gets an empty result, identical to
   asking for one that does not exist, so the API never confirms that a record
   they may not read is there.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/** Matches nothing, ever. Returned by extraFilters to refuse a whole model. */
const DENY = { id: -1 };

/** Pin a query to the requesting user's organization. */
function tenant(req) {
  return { OrganizationId: req.user.OrganizationId };
}

/**
 * Workspace ids the principal may reach, or 'all'.
 * Resolved once per request by middleware/tenant.js and cached on req.
 */
function workspaceIds(req) {
  const u = req.user;
  if (!u) return [];
  if (u.user_type === 'admin' || u.all_workspaces) return 'all';
  return u.workspaceIds || [];
}

/**
 * A `where` fragment limiting rows to the principal's practices.
 * @param {string} [column] - which column names the practice
 */
function workspaceScope(req, column = 'WorkspaceId') {
  const ids = workspaceIds(req);
  if (ids === 'all') return {};
  /* An empty scope is not "everything" — it is a member of staff attached to
     no practice, who should see nothing rather than the whole network. */
  return { [column]: ids.length ? ids : [-1] };
}

/** Both boundaries at once — the common case. */
function tenantAndWorkspace(req, column = 'WorkspaceId') {
  return { ...tenant(req), ...workspaceScope(req, column) };
}

/** Is this principal the owner of their organization? */
function isOwner(req) { return req.user && req.user.user_type === 'admin'; }

/** The customer record behind a portal login, or null for staff. */
function customerId(req) { return (req.user && req.user.CustomerId) || null; }

module.exports = { DENY, tenant, workspaceIds, workspaceScope, tenantAndWorkspace, isOwner, customerId };
