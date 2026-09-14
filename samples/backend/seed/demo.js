/* ══════════════════════════════════════════════════════════════════════════
   The contents of a demo tenant.

   A visitor who arrives from the landing page has to land in a product that
   is already in use: staff, workspaces, customers, a week of work either side
   of today, private notes and a trail of changes. An empty demo shows nothing
   except that the app can render an empty state, and every screen worth
   looking at is the one with rows in it.

   Three rules this file is written to:

     1. **It runs in production.** `npm ci --omit=dev` installs no
        devDependencies, so nothing here may require `@faker-js/faker` — the
        seed the whole suite uses. A demo seeded with a devDependency works in
        every test and crashes on the first real visitor.

     2. **Everything takes the transaction.** Every create below is handed the
        caller's transaction, so a failure halfway leaves no tenant rather
        than half of one — and on SQLite, whose pool is a single connection, a
        query that does NOT take it waits for a connection the transaction is
        holding, for ever.

     3. **The data obeys the product's own rules.** These rows go in through
        Sequelize, not through the controllers, so nothing checks them: one
        member is not booked twice at ten o'clock because THIS file spaces
        them, not because shared/rules.js was consulted. A demo whose own data
        breaks the rules it advertises is worse than no demo.

   Rewrite this wholesale for your domain. The shape — a full cast, a week
   around today, one record of the restricted model — is the part to keep.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

/* Times as "HH:MM" and dates as "YYYY-MM-DD", like everything else that
   schedules: a timezone must never reach a scheduling decision. `today` is
   the server's day, which in the container is UTC — for a demo that is
   close enough, and for real data it is why these are strings. */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shift = (from, days) => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
};

/* Spaced 90 minutes, and no task runs longer than 60, so no member is ever
   double-booked and shared/rules.js would accept every row here. */
const SLOTS = ['09:00', '10:30', '12:00'];
const TITLES = ['First visit', 'Follow-up', 'Annual review', 'Site survey', 'Handover'];

const CUSTOMERS = [
  { name: 'Northwind Joinery', email: 'hello@northwind.example', phone: '020 7946 0011' },
  { name: 'Bluebird Cafés', email: 'ops@bluebird.example', phone: '020 7946 0022' },
  { name: 'Harbour Dental', email: 'reception@harbour.example', phone: '020 7946 0033' },
  { name: 'Priya Raman Ltd', email: 'priya@raman.example', phone: '020 7946 0044' },
  { name: 'Southgate Removals', email: 'book@southgate.example', phone: '020 7946 0055' },
  { name: 'Cedar Veterinary', email: 'front@cedarvet.example', phone: '020 7946 0066' },
  { name: 'Ollie Byrne Plumbing', email: 'ollie@byrne.example', phone: '020 7946 0077' },
  { name: 'Marlowe Books', email: 'shop@marlowe.example', phone: '020 7946 0088' }
];

/**
 * Build one demo tenant.
 *
 * @param {object} db
 * @param {object} opts
 * @param {import('sequelize').Transaction} opts.transaction - required
 * @param {Date} opts.expiresAt - when the sweeper may take it away
 * @param {string} [opts.ip] - who asked, for the per-IP limit
 * @param {Date} [opts.now]
 * @returns {Promise<{org: object, owner: object}>} the tenant and the account
 *   the visitor is signed in as.
 */
module.exports = async function seedDemoTenant(db, { transaction, expiresAt, ip = null, now = new Date() }) {
  const token = crypto.randomBytes(4).toString('hex');
  const slug = `demo-${token}`;

  const org = await db.Organization.create({
    name: 'Demo Ltd',
    slug,
    status: 'active',
    is_demo: true,
    expires_at: expiresAt,
    created_ip: ip
  }, { transaction });

  /* Every address is unique, undeliverable and obviously fake.

     Unique because e-mail is unique platform-wide, so a fixed
     `owner@demo.example` would let the second concurrent visitor collide with
     the first. `.invalid` because it is the reserved TLD that can never
     resolve, so no mail this tenant provokes can leave the building.

     `password: null` is the important one. A demo account has no password at
     all, and services/passwords.js answers a null hash by comparing against a
     dummy and returning false — so POST /auth/login cannot succeed for one of
     these however it is asked. The only door into a demo tenant is the one
     that created it. */
  const cast = (role, who, extra = {}) => db.User.create({
    OrganizationId: org.id,
    user_type: role,
    name: who,
    email: `${who.toLowerCase().replace(/[^a-z]+/g, '-')}@${slug}.demo.invalid`,
    password: null,
    status: 'active',
    ...extra
  }, { transaction });

  const owner = await cast('admin', 'Owner', { all_workspaces: true });
  const desk = await cast('agent', 'Desk', { all_workspaces: true });
  const alice = await cast('member', 'Alice', { all_workspaces: false });
  const ben = await cast('member', 'Ben', { all_workspaces: false });
  const portal = await cast('customer', 'Portal', { all_workspaces: false });

  const north = await db.Workspace.create({
    OrganizationId: org.id, code: 'N', name: 'North', city: 'Leeds'
  }, { transaction });
  const south = await db.Workspace.create({
    OrganizationId: org.id, code: 'S', name: 'South', city: 'Bristol'
  }, { transaction });

  await db.UserWorkspace.bulkCreate([
    { OrganizationId: org.id, UserId: alice.id, WorkspaceId: north.id },
    { OrganizationId: org.id, UserId: ben.id, WorkspaceId: south.id }
  ], { transaction });

  /* Half the book in each workspace, so the second scope boundary is visible
     the moment somebody switches to a member: Alice sees four customers where
     the owner sees eight. That contrast IS the demo. */
  const rows = [];
  for (let i = 0; i < CUSTOMERS.length; i += 1) {
    const inNorth = i < CUSTOMERS.length / 2;
    rows.push(await db.Customer.create({
      OrganizationId: org.id,
      WorkspaceId: inNorth ? north.id : south.id,
      MemberId: inNorth ? alice.id : ben.id,
      ...CUSTOMERS[i]
    }, { transaction }));
  }

  /* The portal login is one of the customers, so the narrowest role in the
     product has a record to be scoped to. */
  await rows[0].update({ UserId: portal.id }, { transaction });

  const teams = [
    { member: alice, workspace: north, book: rows.slice(0, 4) },
    { member: ben, workspace: south, book: rows.slice(4) }
  ];

  /* Two days behind and four ahead: a demo opened on a Monday morning has to
     have both a history and a diary, or half the screens are empty. */
  const tasks = [];
  for (let day = -2; day <= 4; day += 1) {
    const date = ymd(shift(now, day));
    teams.forEach(({ member, workspace, book }) => {
      SLOTS.forEach((start, i) => {
        /* Rotated by the day, so a customer is never booked twice on one
           day — the other half of what keeps these rows legal. */
        const customer = book[(day + i + book.length * 2) % book.length];
        tasks.push({
          OrganizationId: org.id,
          WorkspaceId: workspace.id,
          CustomerId: customer.id,
          MemberId: member.id,
          date,
          start,
          duration: [30, 45, 60][i % 3],
          status: day < 0 ? 'done' : 'scheduled',
          title: TITLES[(day + i + TITLES.length) % TITLES.length],
          price: day < 0 ? 40 + i * 15 : null
        });
      });
    });
  }
  await db.Task.bulkCreate(tasks, { transaction });

  /* The restricted model: the front desk may not read any of these, which is
     the thing a visitor should try. */
  await db.Note.bulkCreate([
    { OrganizationId: org.id, CustomerId: rows[0].id, MemberId: alice.id,
      date: ymd(shift(now, -2)), body: 'Prefers a morning slot. Do not call before 09:00.', shared: false },
    { OrganizationId: org.id, CustomerId: rows[1].id, MemberId: alice.id,
      date: ymd(shift(now, -1)), body: 'Invoice goes to the head office, not the branch.', shared: true },
    { OrganizationId: org.id, CustomerId: rows[5].id, MemberId: ben.id,
      date: ymd(now), body: 'Access is through the yard; the front door is never used.', shared: false }
  ], { transaction });

  /* A trail with something in it, written in the same vocabulary the hooks
     use — services/audit.js FIELD — so the filter on the audit screen has
     entries to match rather than one row per free-text label. */
  const stamp = { date: ymd(now), time: '09:14' };
  await db.AuditEntry.bulkCreate([
    { OrganizationId: org.id, ...stamp, UserId: owner.id, user_name: owner.name, user_role: 'admin',
      entity: 'customer', entity_id: rows[0].id, label: rows[0].name, CustomerId: rows[0].id,
      WorkspaceId: north.id, MemberId: alice.id, action: 'create', field: 'Customer',
      from_value: null, to_value: rows[0].name },
    { OrganizationId: org.id, ...stamp, time: '11:02', UserId: desk.id, user_name: desk.name, user_role: 'agent',
      entity: 'customer', entity_id: rows[1].id, label: rows[1].name, CustomerId: rows[1].id,
      WorkspaceId: north.id, MemberId: alice.id, action: 'update', field: 'Phone',
      from_value: '—', to_value: rows[1].phone },
    { OrganizationId: org.id, ...stamp, time: '14:37', UserId: alice.id, user_name: alice.name, user_role: 'member',
      entity: 'task', entity_id: null, label: TITLES[0], CustomerId: rows[2].id,
      WorkspaceId: north.id, MemberId: alice.id, action: 'update', field: 'Status',
      from_value: 'scheduled', to_value: 'done' },
    { OrganizationId: org.id, ...stamp, time: '16:05', UserId: owner.id, user_name: owner.name, user_role: 'admin',
      entity: 'staff', entity_id: ben.id, label: ben.name, CustomerId: null,
      WorkspaceId: south.id, MemberId: ben.id, action: 'update', field: 'Access',
      from_value: 'No', to_value: 'Yes' }
  ], { transaction });

  return { org, owner };
};
