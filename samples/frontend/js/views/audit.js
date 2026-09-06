/* ══════════════════════════════════════════════════════════════════════════
   Audit — the trail, read-only.

   The route is gated on `audit.view`, but the gate is a courtesy: what
   actually decides which rows exist is audit_entry.controller's extraFilters,
   which subtracts the restricted model's entries for any role that may not
   read it. A screen cannot be trusted to hide a row it was sent.
   ═══════════════════════════════════════════════════════════════════════ */
window.Views = window.Views || {};
window.Views.audit = (function () {
  'use strict';

  var e = U.esc;

  function load() {
    return API.get('/audit-entries', { limit: 200, sort_by: ['date', 'time'], sort_direction: 'DESC' })
      .then(function (res) { return res.ok ? (res.data || []) : []; });
  }

  function render(params, rows) {
    if (!rows.length) return C.empty('Nothing recorded yet.');

    return '<h1 class="page-title">Audit</h1>' +
      '<table class="table"><thead><tr>' +
        '<th>When</th><th>Who</th><th>Record</th><th>Field</th><th>From</th><th>To</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td>' + e(r.date + ' ' + r.time) + '</td>' +
          '<td>' + e(r.user_name) + '</td>' +
          '<td>' + e(r.label || '—') + '</td>' +
          '<td>' + e(r.field) + '</td>' +
          '<td>' + e(r.from_value) + '</td>' +
          '<td>' + e(r.to_value) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  return { load: load, render: render };
})();
