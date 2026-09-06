/* ══════════════════════════════════════════════════════════════════════════
   Store — the app's view of the server, and the ONLY thing that talks to it.

   Views never call API directly. Three jobs:

     1. **Fetching.** `boot()` reads the principal and the reference data —
        who am I, what may I do, and the workspaces and staff every screen
        names. `load(spec)` fetches the transactional slice one screen needs.
        Nothing transactional is kept between navigations.

     2. **Translating.** The API speaks in columns (`MemberId`, `all_workspaces`);
        the interface speaks the vocabulary the product was written in
        (`memberId`, `allWorkspaces`). One boundary does that conversion,
        here, so a column rename is a change to this file rather than to
        fifteen views.

     3. **Asking.** Every mutation is an API call returning a promise that
        resolves to `{ ok, … }`. The server decides; this reports what it
        decided. Where a rule can be answered without a round trip, Rules
        answers instantly from the slice already loaded — and the server
        re-checks anyway. The client copy is convenience, never authority.

   Selectors stay synchronous on purpose: they run inside template strings and
   read the slice the view's own `load()` already awaited. That is the
   load/render split, not a cache — navigate away and the slice goes with you.

   **Record ids are strings on this side of the wire.** Every id a browser
   holds arrives as text — data-id attributes, <select> values, the URL hash —
   so they are converted once, here, in the mappers, and everything in the
   frontend compares strings. The server converts back at the API boundary.
   ═══════════════════════════════════════════════════════════════════════ */
window.Store = (function () {
  'use strict';

  var me = null;
  var caps = [];
  var ref = emptyRef();
  var slice = emptySlice();
  var listeners = [];

  function emptyRef() { return { workspaces: [], users: [] }; }
  function emptySlice() { return { customers: [], tasks: [], notes: [], audit: [] }; }

  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }
  function emit() { listeners.slice().forEach(function (fn) { fn(); }); }

  /* ── Translating API rows into the interface's vocabulary ────────────── */

  function num(v) { return v === null || v === undefined ? null : Number(v); }
  function rid(v) { return v === null || v === undefined ? null : String(v); }

  function toWorkspace(r) {
    return { id: rid(r.id), code: r.code, name: r.name, city: r.city, address: r.address };
  }

  function toUser(r) {
    return {
      id: rid(r.id), name: r.name, email: r.email, role: r.user_type,
      status: r.status, allWorkspaces: !!r.all_workspaces
    };
  }

  function toCustomer(r) {
    return {
      id: rid(r.id), workspaceId: rid(r.WorkspaceId), memberId: rid(r.MemberId),
      name: r.name, email: r.email || '', phone: r.phone || '', status: r.status,
      /* Sent by the server's beforeSend, because the list shows it and does
         not load the tasks it counts. A screen may only count what it
         fetched; the alternative is a confident zero. */
      openTasks: num(r.open_tasks) || 0
    };
  }

  function toTask(r) {
    return {
      id: rid(r.id), workspaceId: rid(r.WorkspaceId), customerId: rid(r.CustomerId),
      memberId: rid(r.MemberId), date: r.date, start: r.start,
      duration: num(r.duration), status: r.status, title: r.title, price: num(r.price)
    };
  }

  /* ── Boot and load ───────────────────────────────────────────────────── */

  function boot() {
    return API.get('/auth/me').then(function (res) {
      if (!res.ok) { me = null; caps = []; return false; }
      me = res.data.user;
      caps = me.capabilities || [];
      return Promise.all([
        API.get('/workspaces', { limit: 200 }),
        API.get('/users', { limit: 500 })
      ]).then(function (answers) {
        ref = {
          workspaces: (answers[0].data || []).map(toWorkspace),
          users: (answers[1].data || []).map(toUser)
        };
        emit();
        return true;
      });
    });
  }

  /**
   * Fetch the slice one screen needs. A plain `load` builds a FRESH slice and
   * fills only what it asked for — which is why a write that re-reads what it
   * changed must use `loadMore`, or refreshing one collection discards every
   * other one the screen was holding.
   */
  function load(spec) {
    var next = emptySlice();
    return fill(next, spec).then(function () { slice = next; emit(); return slice; });
  }

  /** Refresh part of the slice, keeping the rest. */
  function loadMore(spec) {
    return fill(slice, spec).then(function () { emit(); return slice; });
  }

  function fill(target, spec) {
    var jobs = [];
    if (spec.customers) {
      jobs.push(API.get('/customers', spec.customers).then(function (r) {
        target.customers = (r.data || []).map(toCustomer);
      }));
    }
    if (spec.tasks) {
      jobs.push(API.get('/tasks', spec.tasks).then(function (r) {
        target.tasks = (r.data || []).map(toTask);
      }));
    }
    return Promise.all(jobs);
  }

  /* ── Selectors: synchronous, over the slice already loaded ───────────── */

  function currentUser() { return me; }
  function can(cap) { return caps.indexOf(cap) !== -1; }
  function workspaces() { return ref.workspaces; }
  function users() { return ref.users; }
  function customers() { return slice.customers; }
  function tasks() { return slice.tasks; }

  /**
   * A name for an id, or an em dash.
   *
   * Never `'' + undefined`: the literal word "undefined" in front of a user is
   * a missing key somewhere behind the screen, and both browser suites fail a
   * page containing it. A value the interface could not work out has to be
   * said, not shown.
   */
  function userName(id) {
    var u = ref.users.filter(function (x) { return x.id === rid(id); })[0];
    return u ? u.name : '—';
  }

  function workspaceName(id) {
    var w = ref.workspaces.filter(function (x) { return x.id === rid(id); })[0];
    return w ? w.name : '—';
  }

  /* ── Writes: the server decides, this reports ────────────────────────── */

  function saveCustomer(customer) {
    var body = {
      name: customer.name, email: customer.email, phone: customer.phone,
      WorkspaceId: customer.workspaceId, MemberId: customer.memberId
    };
    return customer.id ? API.put('/customers/' + customer.id, body)
                       : API.post('/customers', body);
  }

  function bookTask(task) {
    return API.post('/tasks', {
      WorkspaceId: task.workspaceId, CustomerId: task.customerId,
      MemberId: task.memberId, date: task.date, start: task.start,
      duration: task.duration, title: task.title
    });
  }

  /** Instant feedback while somebody types. The server re-checks regardless. */
  function wouldClash(task) {
    return Rules.firstClash(
      { id: task.id, date: task.date, start: task.start, duration: task.duration,
        MemberId: task.memberId, CustomerId: task.customerId, WorkspaceId: task.workspaceId },
      { tasks: slice.tasks.map(function (t) {
          return { id: t.id, date: t.date, start: t.start, duration: t.duration,
                   status: t.status, MemberId: t.memberId, CustomerId: t.customerId,
                   WorkspaceId: t.workspaceId };
        }) }
    );
  }

  return {
    boot: boot, load: load, loadMore: loadMore, subscribe: subscribe,
    currentUser: currentUser, can: can,
    workspaces: workspaces, users: users, customers: customers, tasks: tasks,
    userName: userName, workspaceName: workspaceName,
    saveCustomer: saveCustomer, bookTask: bookTask, wouldClash: wouldClash
  };
})();
