/* ══════════════════════════════════════════════════════════════════════════
   U — helpers the browser loads and the server require()s.

   DOM-FREE, and it must stay that way: this file runs under Node in the
   backend suite, and that is what makes the rules testable on both sides from
   one implementation. Anything that touches `document` goes in
   frontend/js/dom.js, which extends this same global.

   ES5 syntax and `var`, because it runs unbuilt in whatever browser the
   viewer has. There is no build step.

   Two conventions the whole codebase rests on:

     • Dates are "YYYY-MM-DD" strings and times are "HH:MM" strings. They sort
       correctly as text, they compare with ===, and no timezone can reach a
       scheduling decision. Never construct a Date for scheduling maths.
     • Time arithmetic happens in minutes, through t2m / m2t.
   ═══════════════════════════════════════════════════════════════════════ */
window.U = (function () {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ── Dates ─────────────────────────────────────────────────────────── */

  /** A Date → "YYYY-MM-DD", in local time. */
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function today() { return ymd(new Date()); }

  /** "YYYY-MM-DD" + n days, still a string. */
  function addDays(date, n) {
    var parts = String(date).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function weekStart(date) {
    var parts = String(date).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var back = (d.getDay() + 6) % 7;                       // Monday-first
    return addDays(date, -back);
  }

  function monthStart(date) { return String(date).slice(0, 8) + '01'; }

  /** Days between two "YYYY-MM-DD" strings. */
  function daysBetween(a, b) {
    var pa = String(a).split('-'), pb = String(b).split('-');
    var da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    var dbb = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((dbb - da) / 86400000);
  }

  /* ── Times ─────────────────────────────────────────────────────────── */

  /** "HH:MM" → minutes since midnight. */
  function t2m(t) {
    var parts = String(t).split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  /** Minutes since midnight → "HH:MM". */
  function m2t(m) {
    var mins = ((Math.round(m) % 1440) + 1440) % 1440;
    return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
  }

  /** Do [aStart, aEnd) and [bStart, bEnd) overlap? Minutes, half-open, so
      10:00–10:30 and 10:30–11:00 do NOT clash. */
  function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  /* ── Text and money ────────────────────────────────────────────────── */

  /**
   * Escape everything interpolated into HTML. No exceptions — names and
   * free-text notes are user data, and views return strings.
   */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Money is a plain number of currency units, formatted here.
   *
   * `money(undefined)` would be "NaN" on screen, which is a missing key
   * somewhere behind the view rather than a formatting problem — so it is
   * returned as the em dash the interface uses for "not known", and the
   * browser suites fail any screen containing NaN.
   */
  function money(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toFixed(2) + ' €';
  }

  function money0(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Math.round(Number(v)) + ' €';
  }

  function sortBy(list, key, desc) {
    var get = typeof key === 'function' ? key : function (x) { return x[key]; };
    return list.slice().sort(function (a, b) {
      var x = get(a), y = get(b);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * (desc ? -1 : 1);
    });
  }

  return {
    pad: pad, ymd: ymd, today: today, addDays: addDays,
    weekStart: weekStart, monthStart: monthStart, daysBetween: daysBetween,
    t2m: t2m, m2t: m2t, overlaps: overlaps,
    esc: esc, money: money, money0: money0, sortBy: sortBy
  };
})();
