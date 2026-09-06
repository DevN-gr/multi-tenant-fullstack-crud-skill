/* ══════════════════════════════════════════════════════════════════════════
   Rules — the domain's invariants, in one implementation.

   Loaded by the browser for instant feedback while somebody is typing, and
   require()d by the server, which runs the same functions and refuses
   regardless of what the client claims to have checked. That is the whole
   point of `shared/`: a client-side check must never be the only one, and two
   copies of a rule will drift.

   DOM-free, like everything in shared/.

   The invariants this sample carries — replace them with the ones your
   product actually has, and assert each of them in BOTH suites:

     1. A member has one task per time slot.
     2. A workspace runs at most `capacity` tasks at once.
     3. A customer is never booked in two places at once.
     4. A task starts on the slot grid and lasts an allowed duration.

   These are the product. Changing one is a product decision, not a refactor.
   ═══════════════════════════════════════════════════════════════════════ */
window.Rules = (function () {
  'use strict';

  /** The booking grid, in minutes. */
  var SLOT = 15;

  /** Durations the product allows. */
  var DURATIONS = [15, 30, 45, 60, 90];

  var ACTIVE = ['scheduled', 'done'];

  function endOf(task) { return U.t2m(task.start) + Number(task.duration); }

  function clashes(a, b) {
    return U.overlaps(U.t2m(a.start), endOf(a), U.t2m(b.start), endOf(b));
  }

  /** Tasks on the same day as `task`, excluding `task` itself. */
  function sameDay(task, ctx) {
    return (ctx.tasks || []).filter(function (t) {
      return t.date === task.date &&
        ACTIVE.indexOf(t.status) !== -1 &&
        String(t.id) !== String(task.id);
    });
  }

  /**
   * The first rule `task` breaks, or null.
   *
   * Returns a code the API answers with and the frontend maps to a message —
   * English on the wire, translated at the edge. One function rather than
   * four booleans so that the caller cannot check three of them and forget
   * the fourth.
   *
   * Every id compared here is compared with String(). The server coerces the
   * body to the model's declared types before this runs (see crud.js), which
   * is what stops `MemberId: "7"` from finding no clash with member 7 — but
   * comparing as strings costs nothing and holds on the browser side too,
   * where every id genuinely is text.
   */
  function firstClash(task, ctx) {
    if (U.t2m(task.start) % SLOT !== 0) {
      return { code: 'off_grid', detail: { slot: SLOT } };
    }
    if (DURATIONS.indexOf(Number(task.duration)) === -1) {
      return { code: 'bad_duration', detail: { allowed: DURATIONS } };
    }

    var others = sameDay(task, ctx);

    var member = others.filter(function (t) {
      return String(t.MemberId) === String(task.MemberId) && clashes(t, task);
    })[0];
    if (member) return { code: 'member_busy', detail: { id: member.id, start: member.start } };

    var customer = others.filter(function (t) {
      return String(t.CustomerId) === String(task.CustomerId) && clashes(t, task);
    })[0];
    if (customer) return { code: 'customer_busy', detail: { id: customer.id, start: customer.start } };

    var capacity = (ctx.capacity && ctx.capacity[String(task.WorkspaceId)]) || Infinity;
    var concurrent = others.filter(function (t) {
      return String(t.WorkspaceId) === String(task.WorkspaceId) && clashes(t, task);
    }).length;
    if (concurrent >= capacity) {
      return { code: 'workspace_full', detail: { capacity: capacity } };
    }

    return null;
  }

  /** Convenience for the browser: may this be booked as proposed? */
  function canBook(task, ctx) { return firstClash(task, ctx) === null; }

  return {
    SLOT: SLOT, DURATIONS: DURATIONS, ACTIVE: ACTIVE,
    endOf: endOf, clashes: clashes, firstClash: firstClash, canBook: canBook
  };
})();
