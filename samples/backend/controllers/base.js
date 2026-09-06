/* ══════════════════════════════════════════════════════════════════════════
   The controller every other one starts from.

   Two things are true of every resource in this API and neither should be
   restated once per model:

     • It belongs to exactly one organization, and every read, update, delete
       and create is pinned to the requesting user's. crud.js funnels all of
       them through `extraFilters`, so that is one condition in one place.
     • Its mutations leave an audit row.

   A controller built here gets both, then overrides whatever its own rules
   require. Nothing here decides *what a role may do* — that is each
   controller's own if/else over req.user.user_type, kept explicit and local,
   because an access rule hidden in a shared helper is an access rule nobody
   reads.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const scope = require('../services/scope');
const { auditHooks } = require('../services/audit');

const BASE_READ_ONLY = ['OrganizationId', 'createdAt', 'updatedAt', 'deletedAt'];

/**
 * @param {object} db
 * @param {object} spec
 * @param {object} spec.model              - the Sequelize model
 * @param {object} [spec.audit]            - auditHooks spec; omit to skip the trail
 * @param {string} [spec.workspaceColumn]  - column naming the workspace, when the
 *                                           resource is scoped by one too
 * @param {function} [spec.access]         - (req, db) => extra where conditions, or
 *                                           scope.DENY. Runs after the tenant pin.
 * @param {boolean} [spec.tenantColumn]    - false for a join table that carries no
 *                                           OrganizationId of its own; its `access`
 *                                           must scope it some other way.
 * @param {function} [spec.beforeCreate]   - (req, res, db) extra work on create
 * @param {object} [spec.overrides]        - anything else, applied last
 */
function tenantController(db, spec) {
  const controller = {};

  /* ── Tenancy, and whatever the resource adds on top ─────────────────── */

  controller.extraFilters = async (req) => {
    /* The superadmin holds no tenant-data capability at all, so a tenant
       resource refuses it outright rather than showing it everything. */
    if (req.user.user_type === 'superadmin') return scope.DENY;

    /* A join table carrying no OrganizationId is scoped through the rows it
       joins. Pinning a column that does not exist would generate invalid SQL,
       not a tighter filter. */
    const where = spec.tenantColumn === false ? {} : { ...scope.tenant(req) };

    if (spec.workspaceColumn) {
      Object.assign(where, scope.workspaceScope(req, spec.workspaceColumn));
    }

    if (spec.access) {
      const extra = await spec.access(req, db);
      if (extra === scope.DENY) return scope.DENY;
      Object.assign(where, extra || {});
    }

    return where;
  };

  /* ── Ownership on create ────────────────────────────────────────────────
     The organization is never taken from the request body. A client that
     could name it could write into another tenant with one edited field.
     ─────────────────────────────────────────────────────────────────────── */

  controller.createDefaultAssociations = async (req, res) => {
    delete req.body.OrganizationId;
    if (spec.tenantColumn !== false) req.body.OrganizationId = req.user.OrganizationId;

    if (spec.beforeCreate) await spec.beforeCreate(req, res, db);
  };

  /* ── The audit trail ─────────────────────────────────────────────────── */

  if (spec.audit) {
    const hooks = auditHooks(db, { model: spec.model, ...spec.audit });
    controller.onCreated = hooks.onCreated;
    controller.beforeUpdate = hooks.beforeUpdate;
    controller.afterDelete = hooks.afterDelete;
  }

  /* ── Fields nobody may set from outside ──────────────────────────────── */

  controller.readOnlyFields = async () => BASE_READ_ONLY.slice();

  controller.defaultSortingColumn = 'id';
  controller.defaultSortingDirection = 'ASC';

  Object.assign(controller, spec.overrides || {});
  return controller;
}

/**
 * Compose a `readOnlyFields` hook: the base list plus whatever a role may not
 * touch. Written as a helper because the pattern — "everyone loses these,
 * this role loses more" — recurs and is easy to get subtly wrong by
 * forgetting the base.
 */
function readOnly(base, perRole) {
  return async (req, res) => {
    const list = base.slice();
    const extra = typeof perRole === 'function' ? await perRole(req, res) : perRole[req.user.user_type];
    return list.concat(extra || []);
  };
}

module.exports = { tenantController, readOnly, BASE_READ_ONLY };
