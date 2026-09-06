/* ══════════════════════════════════════════════════════════════════════════
   node-config, resolved against this directory rather than the process's.

   `require('config')` looks for ./config relative to process.cwd(), so the
   backend would only find its own settings when started from backend/. That
   is a trap: the Docker image sets its own WORKDIR, a test runner may not,
   and the failure is a confusing "property is not defined" rather than
   "wrong directory".

   Everything here requires this module instead of `config` directly. It must
   be the first thing that touches node-config, which it is: utils/logger.js
   pulls it in, and logger is at the top of every other dependency chain.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');

process.env.NODE_CONFIG_DIR = process.env.NODE_CONFIG_DIR || path.join(__dirname, 'config');

module.exports = require('config');
