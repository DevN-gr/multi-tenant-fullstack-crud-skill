/* ══════════════════════════════════════════════════════════════════════════
   Organization — the tenant itself, and the ONE resource the superadmin can
   reach.

   Note the inversion: every other controller starts from `tenantController`,
   which denies the superadmin outright. This one is written by hand, because
   its scope is the reverse — the platform account sees every row and each
   owner sees exactly one, their own.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const scope = require('../services/scope');
const audit = require('../services/audit');
const { auditHooks } = require('../services/audit');

module.exports = (db) => {
  const controller = {};

  controller.extraFilters = async (req) => {
    const u = req.user;
    if (u.user_type === 'superadmin') return {};
    if (u.user_type === 'admin') return { id: u.OrganizationId };
    /* Everybody else can see the name of the organization they are in, and
       nothing about any other. */
    return { id: u.OrganizationId };
  };

  controller.createDefaultAssociations = async (req) => {
    if (req.user.user_type !== 'superadmin') {
      req._refusal = { status: 403, body: { error: 'forbidden' } };
      req.body.id = -1;
    }
  };

  controller.onCreateError = (req, res) => {
    if (req._refusal) return res.status(req._refusal.status).json(req._refusal.body);
    res.status(500).json({ error: 'server_error' });
  };

  const hooks = auditHooks(db, {
    model: db.Organization,
    entity: 'organization',
    createField: audit.FIELD.ORGANIZATION,
    fields: { name: audit.FIELD.ORGANIZATION, status: audit.FIELD.STATUS },
    describe: (row) => ({ label: row.name, OrganizationId: row.id })
  });
  controller.onCreated = hooks.onCreated;

  controller.beforeUpdate = async (req, res, body, queryFilter) => {
    if (req.user.user_type === 'superadmin') return hooks.beforeUpdate(req, res, body, queryFilter);
    if (req.user.user_type !== 'admin') { res.status(403).json({ error: 'forbidden' }); return false; }
    /* An owner may rename their organization; suspending it is the
       platform's. */
    if (Object.keys(body).some((k) => k !== 'name')) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return hooks.beforeUpdate(req, res, body, queryFilter);
  };

  controller.deleteFilters = async () => scope.DENY;

  /**
   * The address a demo was requested from is visible to the platform account
   * and to nobody else — not even to the owner of the tenant it created.
   *
   * It is somebody's IP address: personal data, collected for one purpose
   * (spacing out requests at the door) and readable through this endpoint by
   * every role in the tenant unless it is named here. Hidden fields also
   * cannot be filtered or sorted on, so it cannot be probed indirectly
   * either.
   */
  controller.hiddenFields = async (req) =>
    (req.user.user_type === 'superadmin' ? [] : ['created_ip']);

  /* The three demo columns are the sweeper's and the door's, never a
     client's: an expiry a tenant could PUT is a tenant that can grant itself
     another week, and an `is_demo` a tenant could clear is a tenant that
     stops being swept at all. */
  controller.readOnlyFields = async () =>
    ['slug', 'is_demo', 'expires_at', 'created_ip', 'createdAt', 'updatedAt', 'deletedAt'];
  controller.searchableFields = async (req) =>
    (req.user.user_type === 'superadmin' ? ['name', 'slug'] : null);
  controller.defaultSortingColumn = 'name';
  return controller;
};
