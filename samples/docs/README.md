The user-facing manual and its screenshots live here.

`frontend/Dockerfile` copies this directory into the web image, and
`tools/server.js` mounts it at `/docs/` — but only top-level PDFs. That
restriction is deliberate: this is a working directory, holding the manual's
source, every screenshot and the conventions the codebase is written to.
Mounting the whole directory would publish all of it.
