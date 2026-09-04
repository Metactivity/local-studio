#!/usr/bin/env bash
# deploy-spark.sh — deploy the `spark` branch on the station (docs/runbook-spark.md).
#
# Pulls, rebuilds the agent runtime and the frontend, restarts the frontend
# unit, checks /health (runtime) and /ide (frontend), and restores the previous
# build when a build or the health check fails. The unit is never left dead:
# a failed build leaves it running on the old files, a failed health check
# puts the old build back and restarts.
#
# Run as the service user from a login shell so bun is on PATH:
#   bash -lc 'scripts/deploy-spark.sh [--dry-run] [--no-pull]'
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fe="$root/frontend"
rt="$root/services/agent-runtime"
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

# The build outputs the unit serves. `.prev` is the rollback copy; the running
# server keeps its open files across the rename until it is restarted.
builds=("$fe/.next" "$rt/dist")
snapshot() {
  for d in "${builds[@]}"; do
    run rm -rf "$d.prev"
    if [ -e "$d" ]; then run mv "$d" "$d.prev"; fi
  done
}
rollback() {
  for d in "${builds[@]}"; do
    if [ -e "$d.prev" ]; then run rm -rf "$d"; run mv "$d.prev" "$d"; fi
  done
}
discard() { for d in "${builds[@]}"; do run rm -rf "$d.prev"; done; }

if [ "$pull" = 1 ]; then run git -C "$root" pull --ff-only origin spark; fi
snapshot
if ! { run bash -c "cd '$rt' && bun install --frozen-lockfile && bun run build" &&
       run bash -c "cd '$fe' && npm ci --legacy-peer-deps && npm run build"; }; then
  echo "deploy: build failed — previous build restored, $unit untouched" >&2
  rollback
  exit 1
fi
run systemctl --user restart "$unit"
if [ "$dry" = 0 ] && ! wait_healthy; then
  echo "deploy: health check failed — restoring the previous build" >&2
  rollback
  run systemctl --user restart "$unit"
  wait_healthy || echo "deploy: still unhealthy after rollback — journalctl --user -u $unit" >&2
  exit 1
fi
discard
echo "deploy: $(git -C "$root" rev-parse --short HEAD) live — https://$host/ (runtime :8081, frontend $bind:$port)"
