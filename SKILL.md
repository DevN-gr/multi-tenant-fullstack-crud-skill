---
name: crud-stack
description: Build or extend a multi-tenant, role-scoped, audited web app on a generic-CRUD architecture — Express + Sequelize behind one crudThat factory with per-model controller hooks, a no-build-step vanilla JS frontend, a shared rules module both sides run, and a three-container Docker/Traefik/MySQL deployment. Use when starting a new project of this shape, or when adding a model, controller, route, view, test or environment variable to one. Covers the CRUD factory and its hooks, the access model, project layout, the three test suites, and the deployment.
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
frontend/     the browser: app.html, css/, js/, js/views/
shared/       utils.js and rules.js — loaded by the browser AND require()d by
              the server. One implementation of the domain rules, not two.
backend/      the API: Express + Sequelize, MySQL in production, SQLite locally
tools/        static server + API proxy, smoke test, checks
tests/        the frontend unit suite
docs/         the user manual and its screenshots
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
- Anything that needs rendering → `tools/smoke.js`.

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

- **`api`** — `node:20-bookworm-slim`, dependencies installed with
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
- [ ] Visible strings are in the product's language; code, comments and tests
      are English
- [ ] Checked at 390px and desktop, in both themes
