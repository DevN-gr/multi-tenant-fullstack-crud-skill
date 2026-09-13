# samples/

Reference files for the architecture described in `SKILL.md`. They are a
working skeleton of a small multi-tenant product — an organization with
workspaces, staff, customers, scheduled tasks, private notes and an audit
trail — chosen because it exercises every rule the skill talks about: a tenant
boundary, a second scope inside it, a role that is refused a whole model, a
portal login scoped to one row, and domain rules that must hold on both sides
of the wire.

**Read them, adapt them, do not copy them wholesale.** The names are
placeholders (`Acme`, `Workspace`, `Customer`, `Task`, `Note`); the shapes are
the point.

## What to copy verbatim

These are framework, not domain. Take them as they are and change the app
name:

| File | Why it is verbatim |
|---|---|
| `backend/routes/crud.js` | The CRUD factory. Every comment in it is a bug that was paid for; do not trim them. |
| `backend/controllers/template.controller.js` | Documents every hook. Start each new controller from it. |
| `backend/utils/async-handler.js` | Express 4 does not catch a rejected async handler. Without this the error middleware is decorative. |
| `backend/config-dir.js` | node-config resolved against the backend, not the process's cwd. |
| `backend/services/passwords.js` | bcrypt cost as configuration, tokens stored as hashes, constant-time compare. |
| `backend/services/scope.js` | The two scope boundaries and the `DENY` sentinel. Rename the second boundary to yours. |
| `backend/middleware/auth.js`, `csrf.js` | httpOnly session cookie plus the CSRF token it forces you to pay for. |
| `backend/test/http.js` | A cookie-jar client with a bounded timeout per request. |
| `tools/server.js` | Static server + API proxy, so the app and the API are one origin. |
| `frontend/js/api.js` | Errors as values, one silent 401 retry, CSRF echoed from a readable cookie. |
| `ops/acme-deploy.sh` | The deploy half of push-to-main. Rename the file, the lock and the container names; the refusal, the rollback and the lock are the point. |
| `ops/test-deploy.sh` | Drives that script through every path — including the rollback — with a real git repository and a stubbed `docker`. |

## What to rewrite for your domain

Everything else. In particular:

- `backend/models/*` — your tables, your indices.
- `backend/controllers/*.controller.js` — your access model. Read
  `customer.controller.js` first: it is the annotated worked example.
- `backend/services/capabilities.js` — your roles. The comments explain what
  each deliberate omission is protecting; write the equivalent for yours.
- `shared/rules.js` — your invariants. If your product has none, you still
  need this file: it is where anything the browser and the server must agree
  about lives.
- `frontend/js/views/*` — your screens.

## Running the frontend suite as-is

```bash
node tests/run-tests.js       # 29 assertions, no dependencies, no install
```

It passes against these files unchanged, and it is the fastest way to see the
load/render/route contract enforced. The backend suite and the smoke test need
`npm install` in `backend/` and at the root respectively.

The deploy script's own suite also runs as-is, and needs neither Docker nor a
VPS — it builds a real git repository in a temporary directory and puts a stub
`docker` on `PATH`:

```bash
bash ops/test-deploy.sh       # 23 assertions across seven scenarios
```
