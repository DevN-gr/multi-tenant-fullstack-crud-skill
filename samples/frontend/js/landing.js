/* ══════════════════════════════════════════════════════════════════════════
   The landing page's one piece of behaviour: the demo button.

   It stands completely alone. No `U`, no `API`, no `Store` — the app's
   scripts are not loaded on this page and must not become a dependency of
   it, or the marketing page starts booting the application to render its
   hero. tests/run-tests.js evaluates this file in an EMPTY context, so a
   stray reference to a global fails the suite rather than fails in front of
   a visitor.

   The price of standing alone is this file's own copy of two things the app
   also has: the API prefix, and a message for each error code the endpoint
   can answer with. Both are bounded — one path and three codes — and the
   frontend suite asserts that the app and this page cover the same set, so
   an endpoint that grows a fourth refusal cannot leave one of them silent.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ENDPOINT = '/v1/api/demo';
  var APP = '/app.html';

  /* Readable on purpose — see middleware/csrf.js. */
  var CSRF_COOKIE = 'acme_csrf';
  var CSRF_HEADER = 'X-CSRF-Token';

  /**
   * Every refusal this one button can receive, in the product's language.
   *
   * `demo_cooldown` is not a failure so much as an answer: a visitor who
   * already has a demo open is asking for the one they are holding, so they
   * are pointed at it rather than told off.
   */
  var TEXT = {
    demo_cooldown: 'You already have a demo running. Open it, or try again in a few minutes.',
    demo_unavailable: 'Every demo slot is in use just now. Please try again in a few minutes.',
    not_found: 'The demo is not available on this site.',
    offline: 'No connection to the server. Please try again.',
    server_error: 'Something went wrong starting the demo. Nothing was saved.'
  };

  function cookie(name) {
    var parts = String(document.cookie || '').split('; ');
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i];
      var idx = pair.indexOf('=');
      if (idx > -1 && pair.slice(0, idx) === name) return decodeURIComponent(pair.slice(idx + 1));
    }
    return null;
  }

  var status = document.getElementById('demo-status');
  var buttons = [document.getElementById('try-demo'), document.getElementById('try-demo-2')]
    .filter(function (b) { return b; });

  function say(message, withLink) {
    if (!status) return;
    status.textContent = message;
    if (withLink) {
      var link = document.createElement('a');
      link.href = APP;
      link.textContent = 'Open my demo';
      status.appendChild(document.createTextNode(' '));
      status.appendChild(link);
    }
    status.hidden = false;
    /* The page has two of these buttons and one message. Somebody who pressed
       the one at the bottom would otherwise watch nothing happen while the
       explanation sat two screens above them. */
    if (status.scrollIntoView) status.scrollIntoView({ block: 'center' });
  }

  function busy(on) {
    buttons.forEach(function (b) {
      b.disabled = on;
      /* The label changes because provisioning seeds a whole tenant: it is
         fast, and it is not instant, and a button that looks idle for a
         second gets pressed twice. */
      if (on) { b.dataset.label = b.textContent; b.textContent = 'Setting up your demo…'; }
      else if (b.dataset.label) { b.textContent = b.dataset.label; }
    });
  }

  function start() {
    if (status) status.hidden = true;
    busy(true);

    var headers = { 'Content-Type': 'application/json' };
    /* A visitor who already holds a session carries its cookie, and the API
       demands the CSRF header from anything that does. Sending the token
       when there is one is the whole fix: without it, the second press of
       this button — and every press by somebody whose demo is still open —
       is answered 403 by a page that has no idea why.

       Omitting credentials instead would dodge the CSRF check and throw away
       the Set-Cookie that IS the session. */
    var token = cookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;

    fetch(ENDPOINT, {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: '{}'
    }).then(function (res) {
      if (res.ok) {
        /* assign, not replace: going Back to the page they came from is
           reasonable, and the demo they just made is still theirs. */
        location.assign(APP);
        return null;
      }
      return res.json().catch(function () { return {}; }).then(function (body) {
        var code = (body && body.error) || 'server_error';
        busy(false);
        say(TEXT[code] || TEXT.server_error, code === 'demo_cooldown');
      });
    }, function () {
      busy(false);
      say(TEXT.offline);
    });
  }

  buttons.forEach(function (b) { b.addEventListener('click', start); });
})();
