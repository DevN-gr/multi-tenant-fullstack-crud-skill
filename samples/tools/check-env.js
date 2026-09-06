#!/usr/bin/env node
/**
 * A setting is one change that touches four places, and every partial state
 * is silent:
 *
 *   1. backend/config/custom-environment-variables.json — the mapping.
 *      Without it the variable is set in the environment and read by nobody.
 *   2. .env.example — documented, not merely listed.
 *   3. the `environment:` block of the compose service that reads it.
 *   4. backend/config/default.json, when there is a sane default. When there
 *      is not, the code must refuse to boot and say which variable is missing.
 *
 * A mapped variable nothing forwards is read as its default. An .env.example
 * entry no service passes through is a value the operator fills in and the
 * container never sees. Both fail here rather than at three in the morning.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];

/** Every leaf string in the mapping file is an environment variable name. */
function mappedNames(node, found = new Set()) {
  if (typeof node === 'string') { found.add(node); return found; }
  if (node && typeof node === 'object') {
    if (typeof node.__name === 'string') { found.add(node.__name); return found; }
    Object.entries(node).forEach(([key, value]) => {
      if (key.startsWith('_')) return;                       // a comment key
      mappedNames(value, found);
    });
  }
  return found;
}

const mapping = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'backend/config/custom-environment-variables.json'), 'utf8'));
const mapped = mappedNames(mapping);

const exampleText = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const documented = new Set(
  exampleText.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0].trim())
);

/* Variables the deployment's shape decides rather than the operator: they are
   fixed in the compose file and named in .env.example's closing block, so they
   are documented where they cannot be set. Giving one an .env entry invites
   somebody to answer a question that is not theirs. */
const FIXED = new Set(['NODE_ENV', 'PORT', 'HOST', 'COOKIE_SECURE', 'APP_URL',
  'MAIL_TRANSPORT', 'CORS_ORIGIN', 'API_ORIGIN']);

const composeFiles = fs.readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
const composeText = composeFiles
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

mapped.forEach((name) => {
  if (!documented.has(name) && !FIXED.has(name)) {
    problems.push(`${name} is mapped in custom-environment-variables.json but absent from .env.example`);
  }
  if (!composeText.includes(name)) {
    problems.push(`${name} is mapped but no compose service forwards it — it will read as its default`);
  }
});

documented.forEach((name) => {
  if (!mapped.has(name) && !composeText.includes(name)) {
    problems.push(`${name} is in .env.example but is mapped nowhere and forwarded by nothing`);
  }
});

if (problems.length) {
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  console.error(`\n${problems.length} environment problem(s)`);
  process.exit(1);
}
console.log(`✓ ${mapped.size} variables mapped, documented and forwarded`);
