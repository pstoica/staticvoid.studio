import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// Multi-page static site. Each micro-app is its own HTML entry; the build
// emits a flat `dist/` that mirrors these paths (served by Cloudflare Pages).
//
//   index.html            -> /                  (landing)
//   omnichord/index.html  -> /omnichord/        (wave omnichord app)
//   public/*              -> /*                 (assets copied verbatim: tiles, favicon, harp/privacy.html)
//
// To add a micro-app: drop `<name>/index.html`, add it to `input` below.
// Source files live in the repo but are NOT served — only `dist/` is deployed,
// which keeps app source private once Cloudflare builds with output dir `dist`.
const entry = (p) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  appType: 'mpa',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        omnichord: entry('./omnichord/index.html'),
      },
    },
  },
  server: { port: 8731, host: true },
  preview: { port: 8731 },
})
