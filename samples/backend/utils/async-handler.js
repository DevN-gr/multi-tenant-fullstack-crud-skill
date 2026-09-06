/* ══════════════════════════════════════════════════════════════════════════
   Express 4 does not know what a promise is.

   A handler declared `async` that rejects does not reach the error
   middleware — it becomes an unhandled rejection, and Node 15+ terminates
   the process on one. So a single `POST /auth/forgot-password` against a
   misconfigured mailer took the whole API down, with no response ever sent
   and app.js's error handler never consulted.

   Every route and every middleware in this API is mounted through `wrap`,
   which turns a rejection back into `next(err)`. That is what makes app.js's
   closing "unhandled error" handler true rather than aspirational.

   Express 5 does this itself; when the upgrade happens this can go.
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';

/**
 * @param {function} handler - (req, res, next) or (err, req, res, next)
 * @returns {function} the same handler, with rejections routed to next()
 */
function wrap(handler) {
  if (handler.length >= 4) {
    return function wrappedError(err, req, res, next) {
      let out;
      try {
        out = handler(err, req, res, next);
      } catch (thrown) {
        return next(thrown);
      }
      if (out && typeof out.catch === 'function') out.catch(next);
      return undefined;
    };
  }

  return function wrapped(req, res, next) {
    let out;
    try {
      out = handler(req, res, next);
    } catch (thrown) {
      return next(thrown);
    }
    if (out && typeof out.catch === 'function') out.catch(next);
    return undefined;
  };
}

/**
 * A router whose verbs wrap every handler handed to them, so a route written
 * as an ordinary `async (req, res) => {}` cannot take the process with it.
 *
 * @param {object} router - an express.Router()
 */
function asyncRouter(router) {
  ['get', 'post', 'put', 'patch', 'delete', 'all'].forEach((verb) => {
    const original = router[verb].bind(router);
    router[verb] = (path, ...handlers) => original(path, ...handlers.map(wrap));
  });
  return router;
}

module.exports = { wrap, asyncRouter };
