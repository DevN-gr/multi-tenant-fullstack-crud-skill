/* ══════════════════════════════════════════════════════════════════════════
   App — routing, the shell, and the one place a write is completed.

   A view is `load(params)` then `render(params, data)`. `load` fetches
   exactly the slice that screen shows and returns a promise; `render` is
   synchronous and returns an HTML string. This file awaits the load, paints a
   skeleton meanwhile, and shows an error state if it fails — one message for
   data that never arrived, another for a `render` that threw. Neither leaves
   the skeleton up, because a screen that hangs forever reads as a slow one.
   A view that needs no data of its own may omit `load`.
   ═══════════════════════════════════════════════════════════════════════ */
window.App = (function () {
  'use strict';

  /* Every route, and the capability it needs. tests/run-tests.js asserts that
     every entry resolves to a real view and that no role is offered a route
     it lacks the capability for. */
  var ROUTES = {
    customers: { view: 'customers' },
    tasks: { view: 'tasks' },
    audit: { view: 'audit', cap: 'audit.view' }
  };

  /* The menu, per role. Same source of truth as ROUTES, so a route nobody can
     reach is visible as an empty NAV entry rather than as a dead link. */
  var NAV = {
    admin: ['customers', 'tasks', 'audit'],
    member: ['customers', 'tasks'],
    agent: ['customers', 'tasks', 'audit'],
    customer: ['tasks']
  };

  var PUBLIC_ROUTES = { login: 1, 'reset-password': 1 };

  /**
   * Every API error code this app can receive, mapped to a message.
   *
   * The API answers in stable English codes; the interface owns the wording.
   * A server that returned display text would put the interface's vocabulary
   * in the wrong repository — and could not be localised without a deploy.
   *
   * Add the mapping in the SAME change as the code, or a real refusal renders
   * as the fallback and the user is told nothing useful.
   */
  var ERROR_TEXT = {
    member_busy: 'That assignee already has something at this time.',
    customer_busy: 'This customer is already booked elsewhere then.',
    workspace_full: 'That workspace is at capacity for this slot.',
    off_grid: 'Start times run on the quarter hour.',
    bad_duration: 'That duration is not one of the allowed lengths.',
    forbidden: 'You do not have access to this.',
    conflict: 'Something with these details already exists.',
    invalid: 'Some of these details are not valid.',
    invalid_reference: 'This refers to something that no longer exists.',
    name_required: 'A name is required.',
    workspace_out_of_scope: 'That workspace is outside your access.',
    unauthenticated: 'Your session has ended. Sign in again.',
    demo_expired: 'This demo has ended and its data has been deleted.',
    not_found: 'That is no longer there.',
    offline: 'No connection to the server.',
    server_error: 'Something went wrong. Nothing was saved.'
  };

  function errorText(code) { return ERROR_TEXT[code] || ERROR_TEXT.server_error; }

  var currentView = null;
  var renderToken = 0;
  var renderSeq = 0;

  /**
   * Published on <html> as data-render-seq, bumped after each completed
   * paint. The browser suites wait on this rather than on "a page with no
   * skeleton" — the PREVIOUS screen satisfies that too, so waiting for it
   * asserts against whatever was already there.
   */
  function painted() {
    document.documentElement.setAttribute('data-render-seq', String(++renderSeq));
  }

  function parseHash() {
    var raw = String(location.hash || '').replace(/^#\/?/, '');
    var parts = raw.split('/');
    return { name: parts[0] || 'customers', id: parts[1] || null };
  }

  function homeRoute() {
    var user = Store.currentUser();
    var allowed = (NAV[user && user.user_type] || [])[0] || 'customers';
    return '#/' + allowed;
  }

  function render() {
    var root = document.getElementById('app');
    var user = Store.currentUser();
    var r = parseHash();

    /* Claimed before anything else, and before the anonymous branch returns:
       signing out is a render too. A `load` still in flight from the screen
       somebody has just left would otherwise paint over the sign-in form. */
    var token = ++renderToken;

    if (!user) {
      currentView = Views.login;
      root.innerHTML = currentView.render(PUBLIC_ROUTES[r.name] ? r : null);
      if (currentView.mount) currentView.mount(root);
      painted();
      return Promise.resolve();
    }

    /* An unknown route is a typo — quietly go home. A route that exists but
       is not for this role is a deliberate deep link, so say why it is
       refused rather than teleporting the user somewhere else. */
    if (!ROUTES[r.name]) {
      if (location.hash !== homeRoute()) { location.hash = homeRoute(); return Promise.resolve(); }
      r = { name: 'customers', id: null };
    }
    var route = ROUTES[r.name];
    if (route.cap && !Store.can(route.cap)) {
      root.innerHTML = shell(r.name, '<div class="empty">You do not have access to this screen.</div>');
      mountShell(root);
      painted();
      return Promise.resolve();
    }

    var view = Views[route.view];
    currentView = view;
    root.innerHTML = shell(r.name, '<div class="skeleton" aria-busy="true"></div>');
    mountShell(root);

    var loading = view.load ? Promise.resolve(view.load(r)) : Promise.resolve(null);

    return loading.then(function (data) {
      if (token !== renderToken) return;              // superseded; drop it
      var html;
      try { html = view.render(r, data); }
      catch (err) {
        root.innerHTML = shell(r.name, '<div class="empty">This screen could not be drawn.</div>');
        mountShell(root);
        painted();
        throw err;
      }
      root.innerHTML = shell(r.name, html);
      mountShell(root);
      if (view.mount) view.mount(root, data);
      painted();
    }, function () {
      if (token !== renderToken) return;
      root.innerHTML = shell(r.name, '<div class="empty">Could not load this screen.</div>');
      mountShell(root);
      painted();
    });
  }

  /**
   * How long a demo tenant has left, in words.
   *
   * Deliberately vague — "in about 22 hours" rather than a countdown to the
   * second — because the number is a reassurance, not a deadline, and a
   * ticking clock in the corner of a product somebody is evaluating reads as
   * pressure. Anything that cannot be worked out is said as "soon" rather
   * than rendered: a banner reading "deleted in NaN hours" fails the browser
   * suite, and deserves to.
   */
  function remaining(at) {
    var ms = new Date(at).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return 'very soon';
    var hours = Math.round(ms / 3600000);
    if (hours >= 2) return 'in about ' + hours + ' hours';
    var minutes = Math.max(1, Math.round(ms / 60000));
    return 'in about ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
  }

  /**
   * The banner a demo tenant wears, and the only thing in the app that knows
   * it is a demo at all.
   *
   * The cast comes from the principal rather than from `Store.users()`: the
   * role somebody switches TO may not be able to list the role they came
   * from, so a switcher built from the staff list loses the way back on its
   * first use. See services/sessions.js.
   */
  function demoBanner() {
    var user = Store.currentUser();
    var demo = user && user.demo;
    if (!demo) return '';

    var options = (demo.cast || []).map(function (member) {
      return '<option value="' + U.esc(String(member.id)) + '"' +
        (String(member.id) === String(user.id) ? ' selected' : '') + '>' +
        U.esc(member.name + ' — ' + member.user_type) + '</option>';
    }).join('');

    return '<div class="demo-banner">' +
      '<span>Demo — everything here is deleted ' + U.esc(remaining(demo.expires_at)) +
      '. Please do not enter real data.</span>' +
      (options ? '<label>Signed in as <select data-action="demo-switch">' + options +
        '</select></label>' : '') +
      '</div>';
  }

  function shell(active, body) {
    var user = Store.currentUser();
    var items = (NAV[user.user_type] || []).map(function (name) {
      return '<a href="#/' + name + '"' + (name === active ? ' class="on"' : '') + '>' +
        U.esc(name) + '</a>';
    }).join('');
    return '<nav class="side">' + items +
      /* Not capability-gated: leaving is not a permission. Every principal
         that can be signed in can sign out, including the platform account,
         which holds no tenant capability at all. */
      '<button class="signout" type="button" data-action="sign-out">Sign out</button>' +
      '</nav><main class="main">' + demoBanner() + body + '</main>';
  }

  /**
   * The shell's own behaviour, attached wherever the shell is painted —
   * including over the skeleton, because the nav is on screen for as long as
   * a slow screen takes to load and a control somebody can see has to work.
   */
  function mountShell(root) {
    var picker = U.el('[data-action="demo-switch"]', root);
    if (picker) {
      picker.addEventListener('change', function () { switchDemoUser(picker.value); });
    }

    var out = U.el('[data-action="sign-out"]', root);
    if (!out) return;
    out.addEventListener('click', function (ev) {
      ev.preventDefault();
      signOut();
    });
  }

  /**
   * Become another member of the demo tenant's cast.
   *
   * The new role may not be allowed on the screen the old one was looking at,
   * so it lands on the new role's home rather than staying put and painting a
   * refusal. Assigning the hash the browser is already on fires no
   * hashchange, so that case renders directly — the same trap the browser
   * suite documents.
   */
  function switchDemoUser(id) {
    return Store.switchDemoUser(id).then(function (res) {
      if (!res || res.ok === false) {
        toast(errorText(res && res.error), 'error');
        return render();
      }
      var home = homeRoute();
      if (location.hash === home) return render();
      location.hash = home;
      return Promise.resolve();
    });
  }

  /**
   * Sign out.
   *
   * The same ending as a session that expired, so it ends the same way the
   * `unauthorized` handler below does: the hash says where we are and a
   * render paints it. `Store.logout` has already refused to forget anything
   * if the server did not answer, so a failure here leaves the user signed
   * in and says so, rather than pretending.
   */
  function signOut() {
    return Store.logout().then(function (res) {
      if (!res || res.ok === false) {
        toast(errorText(res && res.error), 'error');
        return res;
      }
      toast('Signed out.', 'ok');
      location.hash = '#/login';
      return render();
    });
  }

  /**
   * Complete a write: wait, report failure, re-render.
   *
   * Views never handle a promise themselves. Every mutation ends here so that
   * failure is reported the same way everywhere, in the interface's own
   * language, and the screen is repainted from what the server now holds.
   */
  function after(promise, message, modal) {
    return Promise.resolve(promise).then(function (res) {
      if (!res || res.ok === false) {
        toast(errorText(res && res.error), 'error');
        return res;
      }
      if (modal) closeModal();
      if (message) toast(message, 'ok');
      return render().then(function () { return res; });
    });
  }

  function toast(text, kind) {
    var root = document.getElementById('toast-root');
    if (!root) return;
    root.innerHTML = '<div class="toast ' + (kind || '') + '">' + U.esc(text) + '</div>';
    setTimeout(function () { root.innerHTML = ''; }, 4000);
  }

  function closeModal() {
    var root = document.getElementById('modal-root');
    if (root) root.innerHTML = '';
  }

  function start() {
    window.addEventListener('hashchange', render);
    API.on('unauthorized', function () { location.hash = '#/login'; render(); });

    /* A demo tenant that ran out while somebody was using it has no data left
       to show and no session worth keeping, so the app hands them back to the
       landing page, where they can start another one. `replace` rather than
       `assign`: the Back button must not return to an application that can no
       longer load a single screen. */
    API.on('demo-expired', function () { location.replace('/'); });

    return Store.boot().then(render);
  }

  return {
    ROUTES: ROUTES, NAV: NAV, ERROR_TEXT: ERROR_TEXT,
    start: start, render: render, after: after, errorText: errorText,
    parseHash: parseHash, homeRoute: homeRoute, toast: toast, closeModal: closeModal,
    remaining: remaining, demoBanner: demoBanner
  };
})();

if (typeof document !== 'undefined' && document.getElementById) {
  document.addEventListener('DOMContentLoaded', function () { App.start(); });
}
