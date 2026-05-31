#!/usr/bin/env bash
# Manual build for the wave omnichord app.
# Source of truth:  src/omnichord/index.html   (edit here)
# Published output:  omnichord/index.html       (what Cloudflare Pages serves at /omnichord/)
#
# Run from the repo root:  ./build-omnichord.sh
# Then commit & push to deploy. A proper build pipeline can replace this later.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src/omnichord/index.html"
OUT="$ROOT/omnichord/index.html"

[ -f "$SRC" ] || { echo "error: source not found at $SRC" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
cp -f "$SRC" "$OUT"
echo "built: src/omnichord/index.html → omnichord/index.html ($(wc -l < "$OUT" | tr -d ' ') lines)"
