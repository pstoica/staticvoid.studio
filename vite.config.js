import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'

// Multi-page static site. Each micro-app is its own HTML entry; the build
// emits a flat `dist/` that mirrors these paths (served by Cloudflare Pages).
//
//   index.html            -> /                  (landing)
//   omnichord/index.html  -> /omnichord/        (wave omnichord app, vanilla JS)
//   tictactoe/index.html  -> /tictactoe/        (tic-tac-toe app, React + TS)
//   public/*              -> /*                 (assets copied verbatim: tiles, favicon, harp/privacy.html)
//
// To add a micro-app: drop `<name>/index.html`, add it to `input` below.
// React/TSX entries work via @vitejs/plugin-react; vanilla entries are untouched
// by it. Rollup code-splits per entry, so React only lands in the tictactoe chunk.
// Source files live in the repo but are NOT served — only `dist/` is deployed,
// which keeps app source private once Cloudflare builds with output dir `dist`.
const entry = (p) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  appType: 'mpa',
  plugins: [react()],
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',   // tic-tac-toe's CSS modules expect camelCase locals
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        omnichord: entry('./omnichord/index.html'),
        tictactoe: entry('./tictactoe/index.html'),
        loom: entry('./loom/index.html'),
      },
    },
  },
  server: { port: 8731, host: true },
  preview: { port: 8731 },
})
