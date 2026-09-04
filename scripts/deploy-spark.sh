#!/usr/bin/env bash
# deploy-spark.sh — deploy the `spark` branch on the station (docs/runbook-spark.md).
#
# Pulls, builds the target commit in a throwaway git worktree beside the
# checkout (<root>-build/<sha>), then swaps the build outputs into the live
# tree with one `mv` each and restarts the frontend unit. The running server
# never sees a half-built tree: it serves the previous build until the swap,
# which happens right before the restart. `/health` (runtime) and `/ide`
# (frontend) are checked afterwards; a failed build leaves the live tree
# untouched, a failed health check puts the previous outputs back and restarts.
#
# Run as the service user from a login shell so bun is on PATH:
#   bash -lc 'scripts/deploy-spark.sh [--dry-run] [--no-pull]'
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fe="$root/frontend"
rt="$root/services/agent-runtime"
build_root="$root-build"
unit=localstudio-frontend
dry=0
pull=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --no-pull) pull=0 ;;
    *) echo "usage: $0 [--dry-run] [--no-pull]" >&2; exit 2 ;;
  esac
done
run() { echo "+ $*"; [ "$dry" = 1 ] || "$@"; }

# One deploy at a time: a second run refuses instead of racing on the swap.
mkdir -p "$build_root"
exec 9>"$build_root/.lock"
flock -n 9 || { echo "deploy: another deploy is running (lock $build_root/.lock)" >&2; exit 1; }

# The private registry token for @metactivity/* (bun reads $NODE_AUTH_TOKEN via
# bunfig.toml); the station keeps it in the tuum-server env file.
if [ -z "${NODE_AUTH_TOKEN:-}" ] && [ -r /etc/ai/tuum-web.env ]; then
  NODE_AUTH_TOKEN="$(sed -n 's/^NODE_AUTH_TOKEN=//p' /etc/ai/tuum-web.env | head -1)"
  export NODE_AUTH_TOKEN
fi

# Bind address, port and production hostname come from the frontend env file:
# the health check must present the Host the frontend allow-lists.
env_value() { sed -n "s/^$1=//p" "$fe/.env.local" | head -1; }
bind="$(env_value HOSTNAME)"; bind="${bind:-127.0.0.1}"
port="$(env_value PORT)"; port="${port:-4783}"
host="$(env_value ALLOWED_TAILSCALE_HOSTS | cut -d, -f1)"; host="${host:-$bind}"

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }
healthy() {
  [ "$(status http://127.0.0.1:8081/health)" = 200 ] &&
    [ "$(status -H "Host: $host" "http://$bind:$port/ide")" = 200 ]
}
wait_healthy() {
  for _ in $(seq 1 30); do
    healthy && return 0
    sleep 2
  done
  return 1
}

if [ "$pull" = 1 ]; then run git -C "$root" pull --ff-only origin spark; fi
sha="$(git -C "$root" rev-parse --short HEAD)"
bt="$build_root/$sha"

# What the unit serves, relative to the checkout: the Next build (standalone +
# static), the runtime bundle, and the installs they were built against.
outputs=(frontend/.next frontend/node_modules services/agent-runtime/dist services/agent-runtime/node_modules)
discard() { for o in "${outputs[@]}"; do run rm -rf "$root/$o.prev"; done; }
swap() {
  discard
  for o in "${outputs[@]}"; do
    if [ -e "$root/$o" ]; then run mv "$root/$o" "$root/$o.prev"; fi
    run mv "$bt/$o" "$root/$o"
  done
}
rollback() {
  for o in "${outputs[@]}"; do
    if [ -e "$root/$o.prev" ]; then run rm -rf "$root/$o"; run mv "$root/$o.prev" "$root/$o"; fi
  done
}

# A worktree of the checkout at HEAD: same commit, its own installs and build
# outputs. `npm run setup` installs every workspace, `npm run build` builds the
# frontend and, on the way, bundles the runtime.
if [ -e "$bt" ]; then run git -C "$root" worktree remove --force "$bt"; fi
run git -C "$root" worktree prune
run git -C "$root" worktree add --detach "$bt" HEAD
if ! run bash -c "cd '$bt' && npm run setup && npm run build"; then
  echo "deploy: build failed — live tree untouched, $unit still on the previous build (build tree kept: $bt)" >&2
  exit 1
fi

swap
run systemctl --user restart "$unit"
if [ "$dry" = 0 ] && ! wait_healthy; then
  echo "deploy: health check failed — restoring the previous build" >&2
  rollback
  run systemctl --user restart "$unit"
  wait_healthy || echo "deploy: still unhealthy after rollback — journalctl --user -u $unit" >&2
  exit 1
fi
discard
run git -C "$root" worktree remove --force "$bt"
echo "deploy: $sha live — https://$host/ (runtime :8081, frontend $bind:$port)"
