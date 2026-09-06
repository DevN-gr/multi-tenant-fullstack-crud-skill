/* The one view reachable without a principal. */
window.Views = window.Views || {};
window.Views.login = (function () {
  'use strict';

  function render() {
    return '<form class="login" id="login"><h1>Sign in</h1>' +
      '<label>E-mail<input name="email" type="email" required autocomplete="username"></label>' +
      '<label>Password<input name="password" type="password" required autocomplete="current-password"></label>' +
      '<div class="error" id="err" hidden></div>' +
      '<button type="submit">Sign in</button></form>';
  }

  function mount(root) {
    var form = U.el('#login', root);
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = U.el('#err', root);
      err.hidden = true;
      API.post('/auth/login', {
        email: form.email.value, password: form.password.value
      }).then(function (res) {
        if (!res.ok) {
          /* A wrong password is an expected outcome, not an exception — which
             is why API returns errors as values. */
          err.textContent = res.status === 401
            ? 'Wrong e-mail or password.'
            : App.errorText(res.error);
          err.hidden = false;
          return;
        }
        return Store.boot().then(function () {
          location.hash = App.homeRoute();
          return App.render();
        });
      });
    });
  }

  return { render: render, mount: mount };
})();
