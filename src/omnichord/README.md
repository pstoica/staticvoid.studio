# wave omnichord — source

This is the **source of truth** for the hand-tracking omnichord app.

- Edit: `src/omnichord/index.html`
- Build (publish to the served path): `./build-omnichord.sh` from the repo root
- Deploy: commit + push — Cloudflare Pages auto-deploys `omnichord/index.html` to `/omnichord/`

The published copy at `../../omnichord/index.html` is a build artifact — don't edit it directly; it gets overwritten by the build.

Local dev: serve this folder, e.g. `python3 -m http.server 8731` from `src/omnichord/`, then open http://localhost:8731 (needs a webcam).

> A proper build pipeline (minify, Cloudflare build step that keeps this `src/` private/unserved) is a later task.
