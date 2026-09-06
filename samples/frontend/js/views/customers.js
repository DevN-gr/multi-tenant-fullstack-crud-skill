/* ══════════════════════════════════════════════════════════════════════════
   Customers — the worked example of a view.

   `load` fetches exactly the slice this screen shows and returns a promise.
   `render` is synchronous and returns an HTML string. DOM work lives in
   `mount`. App awaits the load, paints a skeleton meanwhile, and shows an
   error state if either half fails.

   Two rules this file exists to demonstrate:

     • Everything interpolated into HTML goes through `U.esc`. No exceptions:
       names and free-text notes are user data.
     • The screen counts only what its own `load` fetched. `openTasks` comes
       from the server beside the row — see customer.controller's beforeSend —
       because computing it here over an unloaded collection would render a
       confident zero, which is worse than a blank.
   ═══════════════════════════════════════════════════════════════════════ */
window.Views = window.Views || {};
window.Views.customers = (function () {
  'use strict';

  var e = U.esc;
  var state = { search: '' };

  function load() {
    return Store.load({
      customers: { search: state.search, limit: 100, sort_by: 'name' }
    });
  }

  function render() {
    var rows = Store.customers();
    var canCreate = Store.can('customer.create');

    return '<div class="page-head">' +
        '<h1 class="page-title">Customers</h1>' +
        (canCreate ? '<button class="btn" data-action="new-customer">New customer</button>' : '') +
      '</div>' +

      '<input class="input" id="q" type="search" placeholder="Search" value="' + e(state.search) + '">' +

      (rows.length ? '<table class="table"><thead><tr>' +
        '<th>Name</th><th>Workspace</th><th>Assignee</th><th class="num">Open</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (c) {
          return '<tr data-action="open-customer" data-id="' + e(c.id) + '">' +
            '<td>' + e(c.name) + '</td>' +
            '<td>' + e(Store.workspaceName(c.workspaceId)) + '</td>' +
            '<td>' + e(Store.userName(c.memberId)) + '</td>' +
            '<td class="num">' + c.openTasks + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>'
        : '<div class="empty">No customers yet.</div>');
  }

  function mount(root) {
    var q = U.el('#q', root);
    if (q) {
      q.addEventListener('change', function () {
        state.search = q.value;
        App.render();
      });
    }

    U.els('[data-action="open-customer"]', root).forEach(function (row) {
      row.addEventListener('click', function () {
        location.hash = '#/customers/' + row.getAttribute('data-id');
      });
    });

    var add = U.el('[data-action="new-customer"]', root);
    if (add) add.addEventListener('click', openDialog);
  }

  function openDialog() {
    var modal = document.getElementById('modal-root');
    modal.innerHTML = '<div class="modal"><form id="f">' +
      '<h2>New customer</h2>' +
      '<label>Name<input name="name" required></label>' +
      '<label>E-mail<input name="email" type="email"></label>' +
      '<label>Workspace<select name="workspaceId">' +
        Store.workspaces().map(function (w) {
          return '<option value="' + U.esc(w.id) + '">' + U.esc(w.name) + '</option>';
        }).join('') +
      '</select></label>' +
      '<div class="row"><button type="button" data-action="cancel">Cancel</button>' +
      '<button type="submit">Save</button></div>' +
      '</form></div>';

    U.el('[data-action="cancel"]', modal).addEventListener('click', App.closeModal);
    U.el('#f', modal).addEventListener('submit', function (ev) {
      ev.preventDefault();
      var form = ev.target;
      /* Writes are completed through App.after: it waits, reports failure in
         the interface's own language, closes the dialog and re-renders. */
      App.after(Store.saveCustomer({
        name: form.name.value,
        email: form.email.value,
        workspaceId: form.workspaceId.value
      }), 'Customer saved.', true);
    });
  }

  return { load: load, render: render, mount: mount };
})();
