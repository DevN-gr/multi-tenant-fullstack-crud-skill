/* ══════════════════════════════════════════════════════════════════════════
   Express wiring.

   Read the mount list below and you have read the API. Every resource is
   `crudThat(model, controller)`; the behaviour that makes each one correct
   lives in its controller's hooks, not in a route. The only hand-written
   routes are /auth, which is a transition rather than a resource.

   Middleware order is load-bearing:

     cors → cookies → body → attachUser → csrf → tenant → routes

   attachUser must precede csrf, because csrf only guards requests that carry
   a session. tenant must precede the routes, because every controller hook
   assumes req.user.OrganizationId is resolved and trustworthy.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const c = require('./config-dir');
const logger = require('./utils/logger');
const pinoHttp = require('pino-http');

const { wrap } = require('./utils/async-handler');
const crudThat = require('./routes/crud');
const authRoutes = require('./routes/auth');
const authMiddleware = require('./middleware/auth');
const csrf = require('./middleware/csrf');
const tenantMiddleware = require('./middleware/tenant');

const PREFIX = c.get('api_prefix');

/** Origins allowed to send credentialed requests. */
function corsOrigins() {
  const raw = c.get('cors_origins');
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((s) => s.trim()).filter(Boolean);
}

/* ── Resources ────────────────────────────────────────────────────────────
   One line per model, and the whole API surface bar auth. Access control and
   the domain rules live in the controller each row names.

   Declared out here rather than inside the factory so the tests can walk
   model ↔ controller pairs — that a resource is mounted, that it cannot leak
   another organization's rows, that its default sort has an index behind it —
   without booting an HTTP server to find out what exists.
   ───────────────────────────────────────────────────────────────────────── */
const RESOURCES = [
  { path: 'organizations', model: 'Organization', controller: 'organization' },
  { path: 'users', model: 'User', controller: 'user' },
  { path: 'workspaces', model: 'Workspace', controller: 'workspace' },
  { path: 'user-workspaces', model: 'UserWorkspace', controller: 'userWorkspace' },
  { path: 'customers', model: 'Customer', controller: 'customer' },
  { path: 'tasks', model: 'Task', controller: 'task' },
  { path: 'notes', model: 'Note', controller: 'note' },
  { path: 'audit-entries', model: 'AuditEntry', controller: 'auditEntry' }
];

module.exports = (db) => {
  const app = express();

  app.set('trust proxy', true);          // a reverse proxy sits in front

  if (c.get('log_level') !== 'silent') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));
  }

  /* credentials:true forbids a wildcard origin, so every origin is named.
     That is the constraint the compose files' CORS_ORIGIN exists to satisfy. */
  app.use(cors({
    origin(origin, cb) {
      /* No Origin header at all: curl, a health probe, a same-origin form. */
      if (!origin) return cb(null, true);
      cb(null, corsOrigins().includes(origin));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', csrf.CSRF_HEADER],
    exposedHeaders: []
  }));

  app.use(cookieParser());
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

  /* `wrap`, here and below, is what makes the error handler at the bottom of
     this file reachable: both of these are async, and an async middleware
     that rejects under Express 4 never reaches `next(err)` on its own. */
  app.use(wrap(authMiddleware.attachUser(db)));
  app.use(csrf.protect);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use(`${PREFIX}/auth`, authRoutes(db));

  /* Everything past here needs a principal and a resolved tenant. */
  const guarded = express.Router();
  guarded.use(authMiddleware.needAuth);
  guarded.use(wrap(tenantMiddleware(db)));

  const controllers = require('./controllers')(db);

  RESOURCES.forEach(({ path, model, controller }) => {
    guarded.use(`/${path}`, crudThat(db[model], controllers[controller]));
  });

  app.use(PREFIX, guarded);
  app.MOUNTS = RESOURCES.map((r) => r.path);

  /* ── Errors ─────────────────────────────────────────────────────────────
     An unhandled throw inside an async handler reaches here. The client is
     told nothing about it: a stack trace in a response body is a map of the
     server, and the log already has the detail.
     ─────────────────────────────────────────────────────────────────────── */
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  app.use((err, req, res, next) => {
    logger.error({ err, url: req.originalUrl, method: req.method }, 'Unhandled error');
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: 'server_error' });
  });

  return app;
};

module.exports.RESOURCES = RESOURCES;
