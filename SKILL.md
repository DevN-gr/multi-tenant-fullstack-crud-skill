---
name: crud-stack
description: "Build or extend a multi-tenant, role-scoped, audited web app on a generic-CRUD architecture — Express + Sequelize behind one crudThat factory with per-model controller hooks, a no-build-step vanilla JS frontend, a shared rules module both sides run, and a three-container Docker/Traefik/MySQL deployment. Use when starting a new project of this shape, or when adding a model, controller, route, view, test or environment variable to one. Covers the CRUD factory and its hooks, the access model, project layout, the three test suites, and the deployment. Also covers going live: at a first deployment, a question about how to deploy or make the app publicly accessible, or an MVP about to be used, it offers — as questions, never unasked — push-to-main automatic deployment (GitHub Actions running the suites, then SSH to a VPS that rebuilds with Docker Compose and rolls back on a failed healthcheck), a public landing page presenting what the product actually does, and a no-sign-up demo: one button provisions a seeded throwaway tenant, signed in, deleted whole after a day."
license: MIT
metadata:
  version: 1.0.0
  author: Nilos Psathas
  homepage: https://github.com/DevN-gr/multi-tenant-fullstack-crud-skill
---

# The CRUD stack

An architecture for line-of-business web apps: multi-tenant, role-scoped,
audited, and deployable as three containers. It trades framework features for
a surface small enough that one person can hold all of it — no build step, no
migrations, no hand-written CRUD, no action routes.

`samples/` holds a working skeleton of the whole thing. Read the file named in
each section rather than reconstructing it from this page; the comments in
those files are the reasoning, and most of them are bugs that were paid for.

---

## The shape

```
frontend/     the browser: index.html (the public landing page, served at
              `/`), app.html (the application, at `/app.html`), css/, js/,
              js/views/
shared/       utils.js and rules.js — loaded by the browser AND require()d by
              the server. One implementation of the domain rules, not two.
backend/      the API: Express + Sequelize, MySQL in production, SQLite locally
tools/        static server + API proxy, smoke test, checks
tests/        the frontend unit suite
docs/         the user manual and its screenshots
ops/          the VPS half of push-to-main: the deploy script, its test
              harness, and the runbook for whoever has shell on the box
```

Three containers: `web` (static files + proxy), `api`, `db`. The web container
proxies `/v1/api` to the API, so the browser only ever talks to one origin —
which is why the session cookie simply works, with no CORS preflight on every
request and no third-party-cookie policy to fall foul of.

---

## The backend

### Everything is `crudThat`

`backend/routes/crud.js` is a generic CRUD factory. Almost every resource is
served by it, and behaviour comes from the controller it is mounted with:

```js
guarded.use('/customers', crudThat(db.Customer, controllers.customer));
```

The verbs `POST /`, `GET /`, `GET /:id`, `PUT /:id`, `DELETE /:id` are the
**whole surface**.

> **Do not hand-write CRUD endpoints and do not add action routes.**
> `POST /tasks/:id/cancel` is a second authorization surface, and it is the one
> that gets forgotten. What an operation *means* lives in a hook: booking,
> moving, reassigning, completing and cancelling are all one POST and one PUT,
> told apart by what the body carries.

The only hand-written routes are transitions rather than resources — signing
in, provisioning a tenant, moving data in or out. What each of those
*produces* is a resource and is read back through `crudThat` like everything
else.

`app.js` holds a `RESOURCES` table: one row per resource, declared outside the
factory so the tests can walk model ↔ controller pairs without booting a
server. Read that table and you have read the API.

### Controller hooks

Start a new controller from `controllers/template.controller.js` (documents
every hook) or from `controllers/base.js` (already applies the tenant pin and
the audit trail). The worked example is `controllers/customer.controller.js`.

| Hook | Runs | Use it for |
|---|---|---|
| `extraFilters(req, res)` | read, update, delete **and** create | The authorization boundary. Extra `where` conditions per role; `scope.DENY` refuses the model outright. |
| `createDefaultAssociations(req, res)` | before create | Set ownership, fill defaults, strip client-supplied fields, refuse with a reason. |
| `beforeUpdate(req, res, body, filter)` | **before** the write | Re-check rules against the proposed row, and read the "from" values the audit trail needs. Return `false` to refuse. |
| `afterUpdate` / `afterDelete` | after the write, **awaited** | The rest of the operation, not a notification. |
| `onCreated(req, res, row)` | after create | Dependent rows, the audit entry. |
| `beforeSend(req, res, result)` | before the response | Figures a list shows but did not load. |
| `hiddenFields(req, res)` | every read | Columns this role may not see — masked in the body, and unfilterable and unsortable as a consequence. |
| `readOnlyFields(req, res)` | update only | Columns nobody may set from outside. **Does not apply to create.** |
| `allowedIncludes(req, res)` | when `?include=` is sent | The association aliases this role may eager-load. Absent means none. |
| `searchableFields(req, res)` | when `?search=` is sent | Columns the term matches, own or `$Alias.column$`. |
| `deleteFilters(req, res)` | delete only | Narrows further than `extraFilters`. |
| `onCreateError` … `onDeleteError` | on failure | A custom status and body. Without one the framework maps the fault itself. |

Four things about hooks that are load-bearing:

1. **`readOnlyFields` does not apply to create.** The whole body reaches
   `Model.create`. Strip in `createDefaultAssociations` what must not be set.
2. **To refuse a create**, set `req.body.id = -1` and answer from
   `onCreateError`. That is the framework's documented deny signal.
3. **`beforeSend` receives Sequelize instances.** Assigning a property to one
   is silently lost — `toJSON()` serialises `dataValues` and nothing else. Use
   `setDataValue`.
4. **`extraFilters` also bounds create**, evaluated in memory against the
   proposed row. A condition naming the primary key can never be satisfied by
   a new row, which is exactly what makes `scope.DENY` and "your own record,
   only" refusals work.

### Query parameters `readMany` understands

- Filtering: `?column=value`, `?by_<column>_<op>=value` with
  `eq|ne|gt|lt|lte|gte|like|in`, `?in_<column>=1,2,3`
- Sorting: `?sort_by=col&sort_direction=ASC|DESC`, both repeatable
- Pagination: `?offset=&limit=`; `?with_count=true` → `{ data, meta }`;
  `?count_only=true` → the meta alone. Counts use `distinct: true`.
- Search: `?search=term`, across `searchableFields` for that role
- Also: `?include=Alias[,Alias]`, `?show_deleted=true`

A column `hiddenFields` masks cannot be **filtered or sorted** on either, not
only searched — a filter answers "is there a row where this is true" one bit
at a time, which is the same column read slowly. Both paths answer `400`.

### Types on the wire

`crud.js` coerces both the query string and the request body to the types the
model declares. This is not tidiness: hooks reason about the body **before**
the write, in JavaScript, and a browser sends every id as text.
`MemberId: "7"` compared against a row holding `7` finds no clash, and the
first invariant is walked straight past by sending a string.

If you add a hook that compares a body value to something already loaded,
assume the body has been coerced and do not convert again.

### The access model

Three files, and the division between them is the point:

- **`services/capabilities.js`** — what each role may *do*. One table, sent to
  the browser from `/auth/me` so there is one definition rather than two that
  can disagree. Hiding a button is a courtesy.
- **`services/scope.js`** — the boundaries every query is pinned to: the
  tenant, always, and a second scope inside it. `DENY` is `{ id: -1 }`, a
  condition that matches nothing.
- **each controller's `extraFilters`** — the enforcement, as a `where` the
  client cannot influence.

Write access rules as an **explicit if/else over `req.user.user_type`**, local
to the controller. A rule hidden in a shared helper is a rule nobody reviews.

**Refuse by returning nothing, not by returning 403.** A role asking for a
record it may not read must get exactly what it would get for a record that
does not exist, or the endpoint becomes an oracle for whether one is there.
Use a status only where the client must act differently: `422` with a code for
a rule the user can fix, `403` for a capability they will never have.

**A failure is never a `200`.** Without an `onXError` hook the framework maps
the fault: `409 conflict`, `422 invalid` / `invalid_reference`,
`500 server_error`. Every code it can produce needs a message in the
frontend's `ERROR_TEXT`, added in the same change as the code.

**Every handler and middleware is wrapped.** Express 4 turns a rejected async
handler into an unhandled rejection, and Node exits the process on one. Use
`wrap` or `asyncRouter` from `utils/async-handler.js`, or the error middleware
is decorative.

### The audit trail

`services/audit.js` composes into a controller through `beforeUpdate`, which
runs *before* the write so the "from" values are still readable. One row per
changed field. Use a label from the `FIELD` table rather than a free string —
the filter dropdown, the seed and the tests all read that one vocabulary.
Rows whose `from` equals `to` are dropped automatically, so pass the whole
field list and let it filter.

The trail is a **second copy of the data**, and it is the copy people forget:
a role refused a model must be refused its audit rows too. See
`controllers/audit_entry.controller.js`.

### Models and the schema

No migrations. `models/index.js` applies the schema on boot with `sync()` —
`force: true` in development and test, `alter` elsewhere — inside `db.init()`,
which `bin/www` awaits before it listens. A container is never
up-but-not-ready.

**`sync({ alter })` does not relax NOT NULL.** A column that starts allowing
null goes on refusing it everywhere the table already existed. This works on
every fresh database and fails on every deployed one, and no test can see it
because the suites rebuild from nothing. `relaxNullability()` reconciles that
one gap, in the loosening direction only.

**SQLite's pool is one connection deep.** Anything that queries from inside a
transaction must be handed that transaction, or it waits for a connection the
transaction is holding — for ever, with no error. Resolve lookups before the
transaction opens where you can.

**`get({ plain: true })` returns `dataValues` by reference** unless there are
custom getters, eager-loaded includes, or `clone: true`. A "snapshot" taken
without `clone` is a live view, and mutating the row it came from rewrites it.

#### Adding a model — checklist

1. `models/<name>.model.js`, exporting
   `(sequelize, DataTypes, db) => { … return X; }`, with `paranoid: true` and
   `OrganizationId` if it is tenant-scoped.
2. Declare **indices for the queries it will actually serve**. Every
   controller's `defaultSortingColumn` must be a contiguous run at either end
   of some index — at the front the index is the order, at the back the
   columns in front are the scope. A sort with nothing behind it is a filesort
   over the whole tenant: invisible on seeded data, expensive on real data.
   `test/indices.test.js` enforces this generically.
3. Register it in `models/index.js`, add the associations, add it to
   `TENANT_SCOPED` if it carries an organization.
4. Write the controller, register it in `controllers/index.js`, add a row to
   `RESOURCES` in `app.js`.
5. Add a test that fails before the change and passes after.

---

## The frontend

**No frameworks and no build step.** Classic scripts, each attaching one
global, loaded in dependency order from `app.html`:

```
U → (js/dom.js extends U) → Rules → API → Store → C → Views.* → App
```

`index.html` — the landing page — loads **none** of them. It is a separate
document that renders with no session and no request, and it stays that way
because the suite evaluates `js/landing.js` in an empty context.

ES5 syntax and `var` in `frontend/js/` and `shared/` — they run unbuilt in
whatever browser the viewer has, and `shared/` also runs under Node. Modern
syntax is fine in `backend/`, `tests/` and `tools/`.

**A view is `load(params)` then `render(params, data)`.** `load` fetches
exactly the slice that screen shows and returns a promise; `render` is
synchronous and returns an HTML string. `App` awaits the load, paints a
skeleton meanwhile, and shows an error state if it fails — one message for
data that never arrived, another for a `render` that threw. Neither leaves the
skeleton up, because a screen that hangs forever reads as a slow one. DOM work
lives in `mount(root, data)`.

**`Store` is the only thing that talks to the server.** Views never call `API`
directly. Reads come from the slice the view's own `load` fetched; writes
return promises completed with `App.after(promise, message, modal)`, which
waits, reports failure, and re-renders. A write that re-reads what it changed
uses `Store.loadMore`, never `Store.load` — a plain load builds a fresh slice
and fills only what it asked for, discarding every other collection the screen
was holding.

**A screen may only count what its `load` fetched.** A view that shows an
aggregate over rows it did not load computes it over an empty slice and
renders a confident zero — worse than a blank, because nothing looks wrong.
Either load the rows or have the server send the figure with the row, in a
grouped query in `beforeSend`.

**A value the interface could not work out has to be said, not shown.** «—»,
an empty state, never the raw absence. `U.money(undefined)` is `NaN` and
`'' + undefined` is a word the reader cannot interpret; both are a missing key
behind the screen, which is why the browser suites fail any page containing
`undefined`, `NaN` or `[object Object]`.

**Escape everything interpolated into HTML with `U.esc()`.** No exceptions.

**Record ids are strings in the browser and integers on the server.** Every id
a browser holds arrives as text — `data-id`, `<select>` values, the URL hash —
so `Store` converts each one once in its mappers and everything on that side
compares strings. The server converts back at the API boundary.

**Dates are `"YYYY-MM-DD"` strings, times are `"HH:MM"` strings,** and time
arithmetic happens in minutes via `U.t2m` / `U.m2t`. Never construct a `Date`
for scheduling maths — a timezone must never reach a slot.

### Adding a view

1. Create `frontend/js/views/<name>.js`.
2. Add the `<script>` tag to `app.html`, **before** `js/app.js`.
3. Register the route in `App.ROUTES` and the menu entry in `App.NAV` for each
   role that gets it.
4. Add the file to the `FILES` list in `tests/run-tests.js` — it asserts every
   route resolves to a real view and that no role is offered a route it lacks
   the capability for.

### `shared/`

`shared/` is **DOM-free** and must stay that way: it runs under Node in the
backend suite, and that is what makes the rules testable on both sides. The
browser-only half of `U` lives in `frontend/js/dom.js`, which extends the same
global. A helper that touches `document` goes there.

**The server is the authority.** The browser runs `Rules` for instant feedback
while somebody types; the server runs the same `Rules` and refuses regardless.
Never let a client-side check be the only one.

---

## The test suites

```bash
npm test                  # frontend units — tests/run-tests.js
cd backend && npm test    # the API        — backend/test/*.test.js
npm run smoke             # browser        — tools/smoke.js, against a live stack
npm run check             # environment-variable parity
npm run verify            # all of the above
```

**Which suite:**

- A rule, a calculation, a helper → `tests/run-tests.js` if it lives in
  `shared/` or `frontend/js/`, `backend/test/` if it lives on the server.
- Anything about who may see or do what → `backend/test/access.test.js`, over
  real HTTP, per role. The frontend cannot prove an access rule; it can only
  prove that it does not offer the button.
- Framework behaviour → `backend/test/crud.api.test.js`, against an isolated
  model with no app boot, auth or seeds.
- Anything that depends on a setting → its own file, with its own
  `NODE_CONFIG` set at the top before anything reads the configuration.
  node:test gives each file a process, which is why `demo.test.js` can boot
  with the demo on and `demo.disabled.test.js` with it off, and neither has to
  mutate configuration at runtime — node-config freezes it anyway.
- Anything that needs rendering → `tools/smoke.js`.
- The deploy script → `ops/test-deploy.sh`, which needs neither Docker nor a
  VPS: a real git repository in a temporary directory and a stubbed `docker`
  on `PATH`.
- The public surface — what `/` serves, what the landing page loads, what its
  button does — → section F of `tests/run-tests.js` for the parts that need no
  browser, and `tools/smoke.js` for the button itself. Both, because the page
  a stranger meets first is the page nobody on the team reloads.

**A denial is asserted as an empty result, not a status code.** A test that
accepts a `403` lets through the regression that turns the endpoint into an
oracle.

**Forms and uploads are driven, not reasoned about.** A form is not finished
until a browser has filled it in and submitted it — not the endpoint behind
it, and not the function that builds the request. The rule is paid for: an
upload route declared `PUT` on the server and sent as `POST` by the browser
answered `404` for every file, while both unit suites passed — one called the
endpoint correctly, the other never issued the request at all. From inside the
browser, a route that does not exist and a route that refuses look identical.

So: a new form, file input or multi-step dialog gets a step in `smoke.js` that
fills it in, submits it, and asserts the result. Anything crossing the wire in
a shape the rest of the app does not use — a raw body, a verb that is not
`POST`, an added header — is driven rather than reasoned about.

**The browser suite fails on any console error, uncaught exception or failed
request.** Keep the console clean rather than filtering the assertion. Steps
that provoke a failure on purpose are wrapped in `expectingFailure()`, which
forgives exactly the noise from that step. Do not widen it.

Rendering is asynchronous, so waiting for "a page with no skeleton" is wrong —
the previous screen satisfies that too. Wait on `data-render-seq`, which the
app bumps after each completed paint.

**Test names are documentation.** When an assertion changes because the rule
changed, the name says which rule and why. When a test exists because
something was once broken, say so. Never delete or weaken a failing assertion
to make the suite green.

Every change ships with coverage for what it changed: new behaviour gets a
test that fails before and passes after; a bug fix gets a test that reproduces
the bug first; changed behaviour updates the existing test to assert the new
rule.

---

## Configuration

Settings live in `backend/config/*.json`, read through `config-dir.js` —
never `process.env` directly, so one file per environment says what the app
believes rather than the shell it happened to start in. Anything that varies
per deployment, and everything secret, arrives as an environment variable
named in `custom-environment-variables.json` and reaches the code as an
ordinary key: `c.get('auth.jwt_secret')`.

**Adding, renaming or removing one is a single change that touches all of
these**, because every partial state is silent:

1. `config/custom-environment-variables.json` — the mapping. Without it the
   variable is set in the environment and read by nobody.
2. `config/default.json` (or the per-environment file) when there is a sane
   default. When there is not, the code refuses to boot and says which
   variable is missing — that is the right pattern for anything secret. A
   credential with a working default is how a known password ends up on a
   public address.
3. `.env.example` — documented, not just listed: what it is for, what a
   plausible value looks like, what happens if it is left blank.
4. The `environment:` block of the compose service that reads it.

`npm run check:env` fails on each partial state. Removing a variable is the
same list in reverse, in one change; renaming one is a removal and an addition
— leaving the old name mapped "for compatibility" means two names for one
setting and no way to tell which is live.

A setting that follows from the shape of the deployment rather than an
operator's choice — `NODE_ENV`, `COOKIE_SECURE`, `APP_URL`, `MAIL_TRANSPORT` —
is fixed in the compose file and named in `.env.example`'s closing block, so
it is documented where it cannot be set. Giving one an `.env` entry invites
somebody to answer a question that is not theirs: a `MAIL_TRANSPORT=console`
on a deployed box sends every invite to a log file.

`NODE_ENV` selects **both** the dialect (`models/index.js`) and the settings
file. Add the two together: an environment with a database entry and no config
file runs on `default.json` and says so only in a warning.

---

## Deployment

Both images build **from the repository root**, because `shared/` is copied
into each of them:

```bash
docker build -f backend/Dockerfile .
docker build -f frontend/Dockerfile .
docker compose up -d --build          # the whole stack
docker compose -f docker-compose.dev.yml up --build   # local, on MySQL
```

- **`api`** — `node:22-bookworm-slim`, dependencies installed with
  `npm ci --omit=dev` before the source is copied so a source change does not
  reinstall them. `--omit=dev` also leaves out `sqlite3`: production is MySQL,
  and **production cannot run on SQLite by construction**. Runs as a non-root
  user and writes nothing to disk. Its `HEALTHCHECK` hits `/health`, and
  because `bin/www` does not listen until the schema is applied, "connection
  refused" means genuinely not ready rather than ready-but-broken.
- **`web`** — the same base image serving `frontend/`, `shared/` and `docs/`
  through `tools/server.js`, and proxying `/v1/api` to the API. Same mappings
  in development and in the image, so a URL that works locally works deployed
  — there is no build step to paper over a difference.
- **`db`** — MySQL, on an `internal: true` network with no route in or out,
  and deliberately not published to the host.
- **Traefik** at the edge: TLS from Let's Encrypt, HTTP redirected to HTTPS
  (the session cookie is `Secure`, so plain HTTP would silently drop it rather
  than merely be unencrypted), plus HSTS, `frameDeny`, `nosniff` and a
  referrer policy as reusable middlewares.

The local stack runs on **MySQL, not SQLite** — SQLite is the test dialect,
and a local stack that never touches MySQL cannot catch a MySQL-only problem.
It also runs a mail catcher, so invite and reset flows can be driven end to
end.

`bin/www` handles `SIGTERM`: in-flight requests finish and the pool closes
cleanly, so a deploy does not leave a half-written transaction.

---

## When the MVP is ready

Three things become relevant at the same moment and none of them is yours to
decide: how it deploys, what strangers see first, and whether they can try it
without being asked for an e-mail address.

The moment is any of these:

- a first deployment;
- a question about how to deploy, how to put it on a domain, or how to make
  the app publicly accessible;
- the app reaching an MVP somebody is about to start using.

**Offer all three, one question each, and build none of them unasked.** Each
costs something to keep: CI minutes, a public page that has to stay true as
the product changes, and a table unauthenticated visitors can write to.

In this order, because each one leans on the one before:

1. **Automatic deployment** — below. A landing page that points at nothing is
   worse than no landing page.
2. **[The landing page](#the-landing-page)** — the front door, and somewhere
   for the demo's button to live.
3. **[The demo tenant](#the-demo-tenant)** — the strongest thing a landing
   page can offer, and the one that needs the other two first.

Ask in one message rather than three, with what each one costs, and take "just
the deploy" for an answer. A product with one real user and no landing page is
a normal product.

---

## Automatic deployment

`samples/.github/workflows/deploy.yml` and `samples/ops/` are a push-to-main
pipeline for this stack: the suites run on a GitHub-hosted runner and, only if
they pass, one SSH connection tells the VPS to rebuild at the commit that was
verified.

### When to offer it — and what to ask first

At the moments above, and at each one **ask rather than build**. How a product
ships is the operator's decision, not a detail to be tidied up on their
behalf.

Two questions before writing any of it:

1. **"Do you want a push to `main` to deploy itself — the suites on a runner
   first, and the VPS only if they pass?"** If the answer is no, the answer is
   no; `docker compose up -d --build` by hand is a legitimate way to run a
   small product.
2. **"Does this VPS run only this app, or other things as well?"** Assume
   *other things* until told otherwise, because everything you put on that box
   has to be named for the project if so: `acme-deploy.sh` and
   `.acme-deploy.lock`, never `deploy.sh` and `.deploy.lock`. Two projects
   sharing one lock file is a collision that shows up as one project's deploy
   mysteriously waiting on another's, months later. The same answer decides
   whether Traefik is yours to restart (it is not, if it fronts anything else),
   whether `docker image prune` is safe box-wide, and whether a
   `Host github.com` block in `~/.ssh/config` would break somebody else's pull.

**Say what the gate costs before building it.** Public repositories get Actions
minutes free; private ones get 2,000 a month on Free and 3,000 on Pro, then
about $0.008 a minute on Linux:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.github.com/repos/OWNER/REPO   # 200 public, 404 private
```

This stack's gate is roughly four to six minutes a run — two `npm ci`s, three
suites and a real Chrome. Multiply by how often they actually merge, say the
number, and let them decide. Revisit it against **Settings → Billing** after a
week rather than the estimate.

### Find these out before writing the workflow

Read the repository for what it can answer; ask for the rest. Every one of
these has a wrong default that fails on the first run:

1. **The command they deploy with today, verbatim.** It encodes the directory,
   the compose file and which services get rebuilt.
2. **Which compose file the VPS actually uses.** A repository carries several
   (`docker-compose.yml`, `.dev.yml`); the one that matters is the one in the
   deploy directory, which may `include:` a file from the checkout. And note
   that **compose service names and container names are different things** —
   this stack's services are `api` and `web`, its containers `acme_api` and
   `acme_web`. `docker compose up` takes the first, `docker inspect` the
   second, and on a shared box `docker inspect api` can answer about somebody
   else's container.
3. **The project's own definition of done.** Here it is `npm run verify`, so
   the CI steps are its parts — split into one named step each, so a red run
   names the suite instead of saying "verify".
4. **The runtime, from `node -v` *and* from `FROM` in every Dockerfile.** They
   differ in this stack, and that difference is the single most likely way a
   first run fails. See below.
5. **Whether the suites want environment variables — or break on them.**
6. **The `HEALTHCHECK` directives.** Both Dockerfiles have one; reuse them as
   the post-deploy gate rather than writing a second probe to be wrong.

### Why the runner, and never the VPS

The honest answer, because it will be asked: the tests do not run in Docker on
either side, and the VPS already has Docker, so what is the runner *for*?

- Not the running of the tests. It is the **clean checkout** — which catches
  the file that was never `git add`ed, and that is the save that actually
  happens — plus `npm ci` from the lockfile rather than months-old
  `node_modules`, and the fact that it runs when somebody is in a hurry, which
  is the whole difference from a local run that is optional.
- **Never move the suites onto the production VPS, and never put a self-hosted
  runner there.** It means Chrome and devDependencies installed next to
  production data, suites competing with live traffic for CPU, and — fatally —
  tests running *after* the code is on the box. A gate that fires
  post-arrival is not a gate.
- If minutes genuinely matter, the honest cheaper option is deploy-only CI
  plus a local pre-push hook. Say that it is bypassable with `--no-verify` and
  still runs against a dirty tree, and let them choose.

### The two files

**The workflow** (`samples/.github/workflows/deploy.yml`) runs on
`push: branches: [main]` — a merge *is* a push — plus `workflow_dispatch` for a
redeploy by hand. `concurrency: {group: production, cancel-in-progress: false}`
so deploys queue rather than truncate: a half-applied `compose up` is worse
than a slow one. The `deploy` job `needs: verify`, which is the only thing
making any of it a gate, and runs exactly one command: `ssh user@host "<sha>"`.

**The server script** (`samples/ops/acme-deploy.sh`) is pinned to the CI key as
a forced command, and:

- takes the commit from `SSH_ORIGINAL_COMMAND` and **refuses anything that is
  not 40 lower-case hex characters**. That is what makes handing a private key
  to GitHub defensible — the key deploys a commit and can do nothing else.
- deploys **the SHA that was verified**, not `origin/main`: when a second merge
  lands mid-build, `origin/main` is no longer what the suites passed against.
- `flock`s, so two deploys cannot interleave over one checkout. The lock lives
  in the deploy directory, **outside** the checkout, where `git reset` cannot
  reach it.
- `git fetch` + `git reset --hard <sha>`, never `git pull`. The checkout is a
  deployment artefact, not a workspace: a pull that stops on a local edit stops
  the deploy with it, and a merge commit made on the server exists nowhere
  else.
- waits on the containers' own healthchecks, then on failure resets to the
  previous commit, rebuilds and exits non-zero — a bad push costs a slow
  deploy, not an outage.
- prunes dangling images older than a week. **Never `-a`**: that command is
  box-wide, and on a shared VPS `-a` deletes every image without a running
  container, including the one another app is about to restart from.

Keep the repository copy as the reviewable source and `scp` it up. **Do not
symlink the server's copy into the checkout** — bash reads a script as it
executes it, and this one `git reset`s the tree it would be living in.

### What bites

1. **Pin CI to the version the suite is developed on, not the one the
   container serves — and check both.** `backend/package.json` runs
   `node --test 'test/**/*.test.js'`, and Node's own glob expansion landed in
   **Node 21**: on `node:20` that exact command answers
   `Could not find 'test/**/*.test.js'` and exits 1. This stack is why the
   check is here — the images ran `node:20` while the suite needed 21, so
   pinning CI to the Dockerfile "for consistency" was precisely the wrong
   instinct. The images are on `node:22` now and the two agree, which is the
   state to keep them in: read `node -v` **and** every `FROM` line before
   writing the workflow, and when they have drifted, pin CI to the suite and
   move the image separately, in its own change with its own deploy.
2. **A suite that arranges its own configuration breaks when you help it.**
   `config/test.json` gives the suites a silent logger, bcrypt at 4 rounds and
   the in-memory mail transport, and `custom-environment-variables.json` maps
   environment over config in *every* environment, `test` included. So an
   `env:` block carrying `MAIL_TRANSPORT` or `LOG_LEVEL` into the verify job
   overrides exactly what the assertions are written against. This stack's
   suites need no secrets: they generate their own. Write no `env:` block.
3. **The VPS can `git pull` by hand and cannot from CI.** The manual pull works
   because an interactive session forwards an ssh-agent; a forced command has
   none. Symptom: `Permission denied (publickey)`, exit 128. Fix: a read-only
   **deploy key** on the VPS, pointed at **per repository** with
   `git config core.sshCommand`, never a global `Host github.com` block in
   `~/.ssh/config` — that box hosts other services. Test it the way CI will,
   with the agent removed, because an interactive test passes and proves
   nothing:

   ```bash
   env -u SSH_AUTH_SOCK git -C ~/deployment/acme fetch --prune origin && echo OK
   ```

4. **Re-running a failed run replays the same commit.** A fix to the *workflow*
   therefore needs a new push — the workflow file is part of the commit being
   re-run. Say this before they reach for the re-run button. A fix to the
   *server* script is different: `scp` it up and the re-run works.
5. **Generating the CI key and authorising it is one command chain, not two.**
   Given separately, the second can be run alone against a `.pub` that is not
   there, appending a line with a command and no key — after which every
   connection, including theirs, is read against a broken `authorized_keys`.
   Join them with `&&`, and give them the check and the undo:

   ```bash
   ssh-keygen -l -f ~/.ssh/authorized_keys        # one fingerprint per parseable line
   sed -i '/,restrict *$/d' ~/.ssh/authorized_keys
   ```

6. **`known_hosts` must match the hostname the workflow dials, exactly.** Build
   the line from the host's own key file rather than a keyscan — no network,
   nothing to intercept — and strip keyscan's `#` banners if one is used:

   ```bash
   printf '%s %s\n' "$(hostname -f)" "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
   ```

   A non-standard port takes the form `[host]:2222 ssh-ed25519 AAAA…`. A
   rotated host key then fails the deploy closed, which is the feature.
7. **An `environment: url:` built from an expression is silently skipped** —
   "Skip setting environment url as environment 'production' may contain
   secret". It is a leak guard. Hardcode the literal or drop the line.
8. **In the script, prefer explicit `if` blocks to cleverness.** `set -e` with
   `case` and `&&` chains is not worth the puzzle; call the rollback directly
   rather than depending on an `ERR` trap firing from inside a loop, and
   remember arithmetic `(( x >= y ))` returns 1 when false — safe inside `if`,
   a landmine anywhere else. Install the rollback trap **after** the first
   mutation: if `git fetch` fails, nothing has changed and there is nothing to
   roll back.

### Prove the script before anyone trusts it

`samples/ops/test-deploy.sh` drives the real script with a **real git
repository** (a bare upstream and a clone, so the fetch/reset/rollback logic is
genuinely under test) and a **stubbed `docker`** on `PATH` whose answers come
from environment variables. Adapt it with the script; it covers:

| Path | Expected |
|---|---|
| a valid SHA | deploys, exit 0, checkout at that commit |
| `bash -i`, `origin/main; rm -rf /`, `main`, a short or upper-case hex string | refused with a message, exit 1, checkout untouched |
| no command at all | falls back to `origin/main` |
| a container that comes up `unhealthy` | rolls back to the previous commit, exit 1 |
| a commit that does not build | rolls back, and the rebuild of the good commit succeeds |
| a container stuck in `starting` | times out, rolls back |
| two deploys at once | the second waits on the lock instead of racing |

Assert the refusal **message**, not merely a non-zero exit: most of those
strings are not valid git revisions either, so a script with the guard deleted
still fails — later, by accident, and for the wrong reason.

### Handing the server side over

These need a person with shell on the box, in this order, each with its check.
`samples/ops/README.md` is that runbook, written to be handed over:

1. `scp` the script up, `chmod +x`, and **run it by hand once** — it should
   deploy and report healthy before any CI exists.
2. The deploy key for GitHub, and `core.sshCommand`, verified with
   `env -u SSH_AUTH_SOCK`.
3. The CI key, generated and pinned to the forced command in one chain:

   ```bash
   ssh-keygen -t ed25519 -f /tmp/ci -N '' -C 'github-actions-deploy' && \
   printf 'command="%s/deployment/acme-deploy.sh",restrict %s\n' "$HOME" "$(cat /tmp/ci.pub)" \
     >> ~/.ssh/authorized_keys
   ```

   `restrict` removes pty, agent and port forwarding. Then `cat /tmp/ci` for
   the secret and `shred -u /tmp/ci /tmp/ci.pub`.
4. Repository secrets `DEPLOY_SSH_KEY` (the whole private key, headers
   included), `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`; variable
   `DEPLOY_PORT` if SSH is not on 22.
5. Worth naming while they are in there: make `verify` a **required status
   check** on pull requests, so a red suite cannot reach `main` at all.

### After the first green run

Say what is still open rather than implying it is finished. Usually:

- suites the gate does **not** cover, and why;
- the version skew between CI and the containers, or a runtime that is EOL;
- `README.md` and the ops documentation, which do not yet mention auto-deploy,
  the deploy key or the secrets — this architecture treats an operator-facing
  change as one that is documented in the same change;
- the real minute usage, from **Settings → Billing** after a week, so the cost
  decision is made on a number rather than an estimate.

---

## The landing page

`samples/frontend/index.html`, `css/landing.css` and `js/landing.js` are a
public front door for this stack: `/` serves the landing page and the
application moves to `/app.html`.

### When to offer it — and what to ask first

At the MVP moment above, and never as a surprise. Three questions, and each
answer changes what gets written:

1. **"Shall I put a public page on `/`, with the app at `/app.html`?"** Some
   products should not have one at all — an internal tool, a private beta, a
   single customer. There, `/` stays the app and the answer is no.
2. **"What does it do *today*?"** Write the list from the code, read it back,
   and let them cut it. A feature list written from the roadmap is a support
   ticket per line, and the person answering those tickets is them.
3. **"Is it meant to be found?"** A page that should not be indexed yet is a
   different page: no sitemap, `noindex` on both documents, and no link from
   anywhere public.

### Why it is a second document, not a route

The app boots by asking `/auth/me` who you are. A marketing page that did that
would answer 401 to every visitor, log two console errors, and paint its hero
after a round trip. So the landing page loads **none** of the eleven scripts
`app.html` loads, and `tests/run-tests.js` evaluates `js/landing.js` in an
**empty** context to keep it that way — the day it needs `U` or `Store` is the
day it has quietly become a second copy of the app shell.

It shares the tokens and nothing else: `css/styles.css` first for the
variables, then `css/landing.css` for the layout. A landing page with its own
palette is one rebrand away from not matching the thing it is selling.

### What bites

- **`/` is what the healthcheck fetches.** Both containers probe it and expect
  200. Moving the front door means moving the mapping in `tools/server.js` in
  the same change, and the suite asserts that whatever `/` resolves to is a
  file that exists — this has already cost one deployment, where `/` answered
  404 while every real request worked, the web container was reported
  unhealthy for ever, and the deploy read that as a failed release and rolled
  back.
- **`noindex` on `app.html`, not on the landing page.** A search result that
  drops somebody on a sign-in form helps nobody. `robots.txt` says the same
  thing to a crawler that reads it — and `.txt` needs a MIME entry, or it is
  served as `application/octet-stream` and offered as a download.
- **Every asset must exist.** The browser suite fails on any failed request,
  and the landing page is the one document a stranger loads first. A missing
  hero image is a failed run, which is the correct severity.
- **No session detection.** The session cookie is `httpOnly`, so this page
  cannot know whether somebody is signed in, and inferring it from the
  readable CSRF cookie is a guess that is wrong for exactly the people it
  would help. Link to the app and let the app decide.
- **Product language.** This is the most visible localised surface in the
  repository; the same rule as every other visible string.
- **No form that has nowhere to go.** An e-mail capture with no list behind it
  and a pricing table the product cannot honour are both worse than the white
  space they fill.

---

## The demo tenant

`samples/backend/routes/demo.js`, `services/demo.js` and `seed/demo.js`: one
unauthenticated POST provisions a whole tenant, seeded and signed in, and a
day later it is deleted — every row of it.

### When to offer it — and what to ask first

After the landing page, because it is the button on it. Three questions:

1. **"Do you want an unauthenticated stranger writing to your production
   database?"** That is what this is, said plainly. The answer is often yes —
   it is the difference between a product somebody can evaluate and a form
   that asks for their e-mail address first — but it must be their yes.
2. **"How long should one live?"** A day is the default and it is a good one:
   long enough to come back after lunch, short enough that a mistake is
   yesterday's problem.
3. **"What should it show?"** If the product's claim is that what you see
   depends on who you are, one role demonstrates nothing. This stack seeds the
   whole cast and puts a switcher in the banner.

### The rules it is built on

- **It is an ordinary tenant, not a mode.** Same tables, same scope filters,
  same controllers, one boolean column. Nothing anywhere says `if (demo)`. The
  tenant boundary that keeps two customers apart is what keeps a demo away
  from real data, and it is already tested per role over real HTTP.
- **Expiry is enforced on the request, not by the timer.** `middleware/tenant.js`
  refuses an expired tenant before any controller sees it. If the sweeper were
  the only thing standing between an expired demo and its data, a crashed
  timer would silently extend every demo for ever and nothing would look wrong
  until somebody noticed a month-old tenant still serving.
- **`force: true`, or it is not deleted.** Every model here is `paranoid`, so
  an ordinary `destroy` writes a `deletedAt` and keeps the row. Without the
  flag, "deleted after a day" is false in the only way that matters, and the
  rows accumulate for ever in tables nobody looks at. The suite asserts the
  counts with `paranoid: false`, because that is the only read that can see
  the difference. Delete children before parents; the foreign keys are real.
- **The door is metered.** A ceiling on how many can be alive at once, and a
  per-address speed bump. Neither is a security control and both are written
  down as what they are: the ceiling bounds a bad afternoon, and the cooldown
  forgets as soon as the sweeper deletes the row it was reading.
- **No password, so there is no second way in.** Demo accounts are created
  with a null password — `passwords.verify` compares a null hash against a
  dummy and returns false, so `/auth/login` cannot succeed for one however it
  is asked. Their addresses are unique per tenant and end in `.invalid`,
  because e-mail is unique platform-wide and the second concurrent visitor
  would otherwise collide with the first.
- **The seed runs in production.** `npm ci --omit=dev` installs no
  devDependencies, so a demo seeded with `@faker-js/faker` — the package the
  test suite seeds with — works in every suite and crashes on the first real
  visitor. And every create takes the caller's transaction: on SQLite, whose
  pool is one connection, a query that does not take it waits for a connection
  the transaction is holding, for ever.
- **The data obeys the product's own rules.** These rows go in through the ORM,
  not through the controllers, so nothing checks them. A demo whose own data
  breaks the invariants it advertises is worse than no demo.
- **Off by default, and 404 when off.** A 403 tells an unauthenticated caller
  that this deployment has a demo endpoint and that it is merely closed, which
  is an invitation to keep asking. Same reasoning as a record somebody may not
  read.

### What bites

- **CSRF, from a page that does not load the API client.** The API demands the
  header from any request carrying a session cookie. The second press of the
  demo button — and every press by somebody whose demo is still open — carries
  one, so the landing page has to read the readable CSRF cookie and echo it
  itself. Omitting credentials instead dodges the check and throws away the
  `Set-Cookie` that IS the session.
- **`req.ip` is only the visitor behind a proxy.** `trust proxy` is set, which
  is right behind Traefik and wrong the moment the app is exposed directly:
  the header is then the client's to write.
- **The session must not outlive the tenant.** Cap the refresh token at the
  tenant's expiry and purge the tokens with the rows, or a browser spends a
  month presenting a token for a tenant nobody can find.
- **The switcher's cast travels with the principal**, not from `/users`: the
  role somebody switches to may not be able to list the role they came from,
  and a switcher that cannot get back is a demo that dead-ends on its second
  click.
- **Say the terms before the button, not after.** No sign-up, what is in it,
  and that it is deleted tomorrow, so please do not put real customer data in
  it. That sentence is the difference between a demo and a trap.
- **The IP address is personal data** with a one-day life. It is collected for
  the rate limit, hidden from every role but the platform's, and deleted with
  the tenant.
- **Demo tenants show up wherever tenants are listed.** The platform account's
  organization list is the obvious one; anything that counts tenants or
  customers is the next. `is_demo` is an ordinary column, so the generic query
  API already answers `?is_demo=false` — this is a default to choose rather
  than code to write.

---

## Language and localisation

If the interface is not in English:

| Where | Language |
|---|---|
| Every visible string, and e-mail to users | the product's language |
| Code, identifiers, comments | English |
| API error codes and JSON keys | English |
| Tests and test names | English |
| README, agent docs | English |

The API answers in stable English codes (`member_busy`, `short_payment`); the
frontend maps them to display text in `App.ERROR_TEXT` and the views. A server
that returned display text would put the interface's vocabulary in the wrong
repository, and could not be localised without a deploy. Conversely, never let
an English string reach a localised interface — including error text, empty
states, tooltips, `aria-label`s and dialog buttons.

---

## Definition of done

- [ ] `npm test` passes, with a test covering the change
- [ ] `cd backend && npm test` passes, likewise
- [ ] `npm run smoke` passes with a clean console
- [ ] Anything a user **types into or uploads through** was driven in a real
      browser, end to end
- [ ] `npm run check` passes
- [ ] `README.md` reflects the change — feature list, access-model matrix,
      project layout, scope and limits
- [ ] A setting added, renamed or removed → mapping, `.env.example` and the
      compose files updated together
- [ ] A change to how it deploys → the workflow, `ops/<project>-deploy.sh` and
      `ops/test-deploy.sh` move together, and `bash ops/test-deploy.sh` passes
- [ ] A new user-facing feature → the landing page's list still describes what
      the product does today, and still names nothing it does not
- [ ] A change to what `/` serves → the mapping in `tools/server.js`, the
      healthcheck's expectation and the browser suite move together
- [ ] A new model or column → the demo seed fills it, and the sweeper's purge
      order deletes it with `force: true`
- [ ] Visible strings are in the product's language; code, comments and tests
      are English
- [ ] Checked at 390px and desktop, in both themes
