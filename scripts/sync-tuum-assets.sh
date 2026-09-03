#!/usr/bin/env bash
# Copies the Tuum Production Design Kit exports (already vendored in the tuum
# checkout) into frontend/public/tuum/. The copies are committed: the app never
# loads branding from Figma or any remote host at runtime.
#   scripts/sync-tuum-assets.sh [path-to-tuum-checkout]
set -euo pipefail
src="${1:-${TUUM_CHECKOUT:-$HOME/Work/Metactivity/tuum}}/ide/extensions/ace-agent/resources"
dst="$(cd "$(dirname "$0")/.." && pwd)/frontend/public/tuum"
[ -d "$src" ] || { echo "tuum resources not found: $src" >&2; exit 1; }
rm -rf "$dst"
for dir in brand icons illustrations providers; do
  mkdir -p "$dst/$dir"
  cp -R "$src/$dir/." "$dst/$dir/"
done
echo "synced $(find "$dst" -type f | wc -l | tr -d ' ') files into $dst"
