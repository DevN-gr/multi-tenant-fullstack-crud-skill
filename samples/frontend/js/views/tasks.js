/* ══════════════════════════════════════════════════════════════════════════
   Tasks — where the shared rules earn their place in the browser.

   `Store.wouldClash` runs the SAME `shared/rules.js` the server runs, against
   the slice this screen already loaded, so somebody typing a start time is
   told immediately. The server checks again and refuses regardless: this is
   feedback, never authority. Deleting the client check would make the app
   feel worse; deleting the server check would make it wrong.
   ═══════════════════════════════════════════════════════════════════════ */
window.Views = window.Views || {};
window.Views.tasks = (function () {
  'use strict';

  var e = U.esc;
  var state = { date: U.today() };

  function load() {
    return Store.load({
      tasks: { date: state.date, sort_by: 'start', limit: 500 },
      customers: { limit: 500, sort_by: 'name' }
    });
  }

  function render() {
    var rows = Store.tasks();

    return '<div class="page-head">' +
        '<h1 class="page-title">' + e(state.date) + '</h1>' +
        '<div><button data-action="prev">‹</button><button data-action="next">›</button></div>' +
      '</div>' +

      (rows.length ? '<table class="table"><thead><tr>' +
        '<th>Time</th><th>Customer</th><th>Assignee</th><th>Status</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (t) {
          var customer = Store.customers().filter(function (c) { return c.id === t.customerId; })[0];
          return '<tr data-id="' + e(t.id) + '">' +
            '<td>' + e(t.start) + '–' + e(U.m2t(U.t2m(t.start) + t.duration)) + '</td>' +
            /* Never `'' + undefined`: an unloaded row is said, not shown. */
            '<td>' + e(customer ? customer.name : '—') + '</td>' +
            '<td>' + e(Store.userName(t.memberId)) + '</td>' +
            '<td>' + C.badge(t.status) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>'
        : C.empty('Nothing booked for this day.'));
  }

  function mount(root) {
    var move = function (n) {
      return function () { state.date = U.addDays(state.date, n); App.render(); };
    };
    var prev = U.el('[data-action="prev"]', root);
    var next = U.el('[data-action="next"]', root);
    if (prev) prev.addEventListener('click', move(-1));
    if (next) next.addEventListener('click', move(1));
  }

  return { load: load, render: render, mount: mount };
})();
