/* ═══════════════════════════════════════════════════════════════════════════
   The half of U that needs a document.

   `shared/utils.js` is loaded by the browser AND require()d by the server, so
   it has to be DOM-free — that is what lets the rules be tested on both sides
   from one implementation. These helpers were sitting at the bottom of it
   once, harmless only because Node never happened to call them; a rule that
   holds by luck is not a rule.

   They extend the same `U` global rather than introducing another one, so
   every call site reads as it always did.
   ════════════════════════════════════════════════════════════════════════ */
(function (U) {
  'use strict';

  function el(sel, root) { return (root || document).querySelector(sel); }
  function els(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function downloadBlob(filename, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  function download(filename, text, mime) {
    downloadBlob(filename, new Blob([text], { type: mime || 'application/json;charset=utf-8' }));
  }

  U.el = el;
  U.els = els;
  U.download = download;
  U.downloadBlob = downloadBlob;
})(window.U);
