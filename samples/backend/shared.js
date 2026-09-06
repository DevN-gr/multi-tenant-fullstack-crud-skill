/* ══════════════════════════════════════════════════════════════════════════
   Bridge to the modules the browser and the server both run.

   The files under `shared/` are classic browser scripts: they attach one
   global each and assume a `window`. Rather than fork them into a server copy
   — two implementations of one rule will drift, and the rule is the product —
   this hands them the global they expect and re-exports what they defined.
   tests/run-tests.js does exactly the same for the browser suite.

   Anything requiring these must go through this file, so the shim is applied
   once and in one place.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

if (!global.window) global.window = global;

require('../shared/utils.js');
require('../shared/rules.js');

module.exports = { U: global.U, Rules: global.Rules };
