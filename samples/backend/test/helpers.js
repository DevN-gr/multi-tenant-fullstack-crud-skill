/* ══════════════════════════════════════════════════════════════════════════
   Shared test setup.

   node:test runs each file in its own process, so every suite gets a private
   in-memory SQLite and can seed whatever it likes without coordinating.

   `bootOnce` exists because generating and loading a realistic dataset costs
   a second or two. Suites that only read it share one copy per process rather
   than paying that per describe block.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.NODE_CONFIG = process.env.NODE_CONFIG || '{"log_level":"silent"}';

const db = require('../models');
const passwords = require('../services/passwords');

let booted = null;

/** The database, schema applied and the platform account bootstrapped. */
async function boot() {
  await db.init();
  return db;
}

/**
 * One organization with staff, workspaces, customers and tasks — enough for
 * every access assertion to have something on both sides of every boundary.
 *
 * Deterministic on purpose. A suite that seeds randomly fails randomly, and a
 * flake in an access test is indistinguishable from a leak.
 */
async function seedOrganization(name = 'Acme Ltd', suffix = '') {
  const org = await db.Organization.create({ name, slug: 'acme' + suffix });
  const password = await passwords.hash('test-password');

  const mk = (user_type, who, extra = {}) => db.User.create({
    OrganizationId: org.id, user_type, name: who,
    email: `${who}${suffix}@example.com`.toLowerCase(),
    password, status: 'active', ...extra
  });

  const admin = await mk('admin', 'Owner', { all_workspaces: true });
  const agent = await mk('agent', 'Desk', { all_workspaces: true });
  const memberA = await mk('member', 'MemberA');
  const memberB = await mk('member', 'MemberB');

  const north = await db.Workspace.create({ OrganizationId: org.id, code: 'N', name: 'North' });
  const south = await db.Workspace.create({ OrganizationId: org.id, code: 'S', name: 'South' });

  await db.UserWorkspace.bulkCreate([
    { OrganizationId: org.id, UserId: memberA.id, WorkspaceId: north.id },
    { OrganizationId: org.id, UserId: memberB.id, WorkspaceId: south.id }
  ]);

  const mine = await db.Customer.create({
    OrganizationId: org.id, WorkspaceId: north.id, MemberId: memberA.id, name: 'Blue Ltd'
  });
  const theirs = await db.Customer.create({
    OrganizationId: org.id, WorkspaceId: south.id, MemberId: memberB.id, name: 'Green Ltd'
  });

  /* A portal login, so the customer role has a record to be scoped to. */
  const portal = await mk('customer', 'Portal');
  await mine.update({ UserId: portal.id });

  const note = await db.Note.create({
    OrganizationId: org.id, CustomerId: mine.id, MemberId: memberA.id,
    date: '2026-09-01', body: 'Private.', shared: false
  });

  const task = await db.Task.create({
    OrganizationId: org.id, WorkspaceId: north.id, CustomerId: mine.id,
    MemberId: memberA.id, date: '2026-09-07', start: '10:00', duration: 30,
    title: 'First visit'
  });

  return { org, admin, agent, memberA, memberB, portal, north, south, mine, theirs, note, task };
}

async function bootOnce() {
  if (booted) return booted;
  booted = (async () => {
    await boot();
    return { db, ...(await seedOrganization()) };
  })();
  return booted;
}

/** A second, unrelated organization — the other side of every tenancy test. */
async function loadSecondOrg() {
  /* E-mail is unique platform-wide, so a second tenant needs distinct
     addresses — exactly what a real second tenant has. */
  return seedOrganization('Other Ltd', '-2');
}

module.exports = { db, boot, bootOnce, seedOrganization, loadSecondOrg };
