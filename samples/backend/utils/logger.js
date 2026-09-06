/* ══════════════════════════════════════════════════════════════════════════
   Structured logging.

   One pino instance for the whole process. Development gets pino-pretty for
   readable output; anything else emits JSON on stdout, which is what the
   promtail → loki → grafana pipeline in docker-compose.yml reads.

   `log_level: "silent"` turns it off entirely — the test suite sets that in
   NODE_CONFIG so a failing assertion is not buried under request logs.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const pino = require('pino');
const c = require('../config-dir');

const level = c.has('log_level') ? c.get('log_level') : 'info';
const pretty = c.has('log_pretty') && c.get('log_pretty');

const options = { level };

/* pino-pretty is a devDependency: asking for it in production would throw,
   and production wants the JSON anyway. */
if (pretty && level !== 'silent') {
  options.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
  };
}

const logger = pino(options);

module.exports = logger;
