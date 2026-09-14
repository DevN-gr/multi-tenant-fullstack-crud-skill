/* ══════════════════════════════════════════════════════════════════════════
   Tenancy guard.

   Two jobs, both of which have to happen before any controller hook runs:

     1. Resolve a portal login to the record behind it, so extraFilters can
        pin CustomerId without a second query per model.

     2. Refuse, outright, any authenticated request that carries no
        organization — with one exception, the superadmin, whose whole purpose
        is to stand outside every tenant.

   And one more that is not about tenancy so much as about time: a demo
   tenant whose day has run out is refused here, before any controller sees
   it.

   The second is the belt to extraFilters' braces. If a controller ever forgot
   its OrganizationId condition, `{ OrganizationId: null }` would match the
   rows of no tenant rather than of every tenant — but a principal with a null
   organization reaching a tenant route at all is a bug, and it should stop
   here rather than be discovered later in a leak.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const demo = require('../services/demo');

module.exports = function tenant(db) {
  return async function resolveTenant(req, res, next) {
    if (!req.user) return next();

    /* A demo tenant stops answering the moment its day is up, whether or not
       the sweeper has got to it yet.

       This is the enforcement; services/demo.js's timer is only storage. A
       sweeper that dies — a crashed timer, a container that keeps running
       with a broken interval — would otherwise silently extend every demo
       for ever, and nothing would look wrong until somebody noticed a
       month-old tenant still serving. Refused here, an expired demo is dead
       on the next request even if nothing ever deletes it.

       Before the portal lookup below, so an expired tenant costs one
       comparison rather than a query. */
    if (demo.hasExpired(req.user.organization)) {
      return res.status(403).json({ error: 'demo_expired' });
    }

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
