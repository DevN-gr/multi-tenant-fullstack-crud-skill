/* ══════════════════════════════════════════════════════════════════════════
   Tenancy guard.

   Two jobs, both of which have to happen before any controller hook runs:

     1. Resolve a portal login to the record behind it, so extraFilters can
        pin CustomerId without a second query per model.

     2. Refuse, outright, any authenticated request that carries no
        organization — with one exception, the superadmin, whose whole purpose
        is to stand outside every tenant.

   The second is the belt to extraFilters' braces. If a controller ever forgot
   its OrganizationId condition, `{ OrganizationId: null }` would match the
   rows of no tenant rather than of every tenant — but a principal with a null
   organization reaching a tenant route at all is a bug, and it should stop
   here rather than be discovered later in a leak.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

module.exports = function tenant(db) {
  return async function resolveTenant(req, res, next) {
    if (!req.user) return next();

    if (req.user.user_type === 'customer') {
      const customer = await db.Customer.findOne({
        where: { UserId: req.user.id },
        attributes: ['id', 'OrganizationId', 'WorkspaceId']
      });
      if (!customer) return res.status(403).json({ error: 'no_customer_record' });

      req.user.CustomerId = customer.id;
      /* A portal login's scope is its own workspace, whatever the account
         row happens to say. */
      req.user.workspaceIds = [customer.WorkspaceId];
      req.user.all_workspaces = false;
    }

    if (req.user.user_type !== 'superadmin' && !req.user.OrganizationId) {
      return res.status(403).json({ error: 'no_organization' });
    }

    next();
  };
};
