/* ══════════════════════════════════════════════════════════════════════════
   C — shared render helpers.

   Views return strings, so these do too. Anything that needs the DOM belongs
   in a view's `mount`, not here.

   Keep this file small and general. A helper used by one screen belongs in
   that screen; a helper used by three belongs here.
   ═══════════════════════════════════════════════════════════════════════ */
window.C = (function () {
  'use strict';

  var e = U.esc;

  function badge(text, kind) {
    return '<span class="badge ' + e(kind || '') + '">' + e(text) + '</span>';
  }

  function meter(percent) {
    var p = Math.max(0, Math.min(100, Math.round(percent || 0)));
    return '<div class="meter"><div class="meter-fill" style="width:' + p + '%"></div></div>';
  }

  function empty(text) { return '<div class="empty">' + e(text) + '</div>'; }

  /**
   * A capability that is agreed but deliberately not built yet.
   *
   * A note, never a warning: nothing is wrong at that spot, there is simply
   * nothing there yet. Pair each marker with an entry in the commitment list
   * — a test asserts the pairing in both directions, so a marker with no
   * entry and an entry no marker points at both fail.
   */
  function soon(label) {
    return '<span class="soon" title="Planned">' + e(label) + '</span>';
  }

  return { badge: badge, meter: meter, empty: empty, soon: soon };
})();
