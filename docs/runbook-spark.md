# Station runbook — `spark` branch

The `spark` branch of this fork is what runs on the station (a DGX Spark, arm64
Linux, single user): Local Studio in the browser with Tuum (Code-OSS reh-web)
embedded as the IDE engine and one agent runtime rooted in ACE (ADR-034 in the
`tuum` repository). No desktop app is built on this line.

This file names units, files and ports only. Values (keys, tokens, hostnames)
live in the env files on the station and in the private notes, never here.

## Topology

| Port | Bind | Process | Unit |
|---|---|---|---|
| 4783 | LAN address | Next.js standalone (`frontend/.next/standalone`) | `localstudio-frontend` |
| 8081 | loopback | agent runtime (`services/agent-runtime/dist/standalone.mjs`), spawned by the frontend launcher | `localstudio-frontend` |
| 8080 | loopback | controller (Bun) | `localstudio-controller` |
| 4784 | all | Tuum reh-web server, base path `/ide` | `tuum-server` |
| 8000 | all | llama-server, chat (launched by the controller) | `localstudio-autolaunch` → controller |
| 8001 | all | llama-server, embeddings | system unit, untouched by deploys |

IDE bridge: the runtime listens on a Unix socket (`TUUM_BRIDGE_SOCKET`, under
`~/.local-studio/`); the Tuum extension host connects to it with
`TUUM_EMBEDDED=1` and `TUUM_ACE_MODE=bridge` from the same env file.

## Units (systemd --user, linger on)

All four are `enabled` and `WantedBy=default.target`; `loginctl show-user
<user> -p Linger` must print `yes` or nothing starts after a reboot.

Boot order: `localstudio-controller` → `localstudio-autolaunch` (oneshot,
posts `/launch/<recipe>` once the controller answers) and
`localstudio-frontend` (`After=` controller; its launcher starts the runtime on
8081 before the Next server). `tuum-server` is independent
(`After=network-online.target`); the `/ide` iframe passes `?folder=`, so the
unit carries no `--default-folder`. Every long-running unit has
`Restart=on-failure`.

`localstudio-frontend` carries a drop-in (`localstudio-frontend.service.d/override.conf`)
with `TimeoutStopSec=10`: the launcher forwards SIGTERM to the Next server
only, so without it a restart waits the 90 s default, the runtime child keeps
8081 alive, and a new launcher silently reuses that stale runtime instead of
starting the freshly built one (`start.mjs` skips the spawn when `/health`
already answers). Ten seconds, then systemd kills the whole control group.

The frontend unit's `PATH` starts with `%h/.bun/bin`: the launcher and the
build need bun. Run anything by hand from a login shell (`bash -lc '…'`) for
the same reason — a build from a non-login shell once removed
`.next/standalone` and left the unit failing.

Env files (mode 600): `frontend/.env.local` (frontend + runtime: bind address,
port, allowed hosts, `ACE_*`, `PI_CODING_AGENT_DIR` → `~/.local-studio/pi-agent`,
`PI_FD_PATH`), `controller/.env`, and `/etc/ai/tuum-web.env` (`tuum-server`:
registry token for `@metactivity/*`, `TUUM_*`).

## Edge

A reverse proxy on the LAN gateway terminates TLS and routes by host:
`/ide/*` → `:4784` (`be_tuum_server`, `timeout tunnel 1h` for the workbench
WebSocket), everything else → `:4783` (`be_localstudio`). Both backends require
HTTP basic auth (`userlist ls_users`); the frontend runs with
`LOCAL_STUDIO_FRONTEND_ALLOW_UNAUTHENTICATED=true` behind it and allow-lists the
public hostname through `ALLOWED_TAILSCALE_HOSTS`. The station firewall only
accepts 4783 from the gateway.

Checking the edge: `haproxy -c -f haproxy.cfg` after any edit (keep a
`haproxy.cfg.bak-YYYYMMDD` copy first), then reload. A WebSocket upgrade cannot
be exercised without the basic-auth password, so the check is the config lines
plus the browser: an `/ide` session that survives a minute idle proves the
tunnel timeout.

## Browser Bridge (W10)

The runtime relays the owner's Chrome extension (`GET /bridge/ws` WebSocket,
`POST /bridge/rpc` JSON-RPC, both on 8081). Browsers cannot send basic auth on
a WebSocket, so `/bridge/ws` is the one path routed past the edge login: the
bridge's own pairing token authenticates the socket.

- Edge: `acl is_bridge_ws path_beg /bridge/ws` → `backend be_bridge_ws`
  (`server <station>:8081 check`, `timeout tunnel 1h`, no `http_auth` rule,
  `http-request set-header Host 127.0.0.1:8081` — the runtime rejects any
  non-loopback Host, on the upgrade and on every route). Every other path
  stays behind basic auth.
- Station: the runtime binds loopback unless
  `LOCAL_STUDIO_AGENT_RUNTIME_HOST=0.0.0.0` is set in `frontend/.env.local`;
  the firewall then allows 8081 from the gateway only. The runtime has no auth
  of its own beyond the Host check, so that firewall rule is the boundary —
  anything on the gateway host can reach the runtime API by sending a loopback
  Host; a runtime-side bearer for the non-loopback listener is the follow-up.
- `LOCAL_STUDIO_BRIDGE_PUBLIC_URL=https://<public hostname>` makes the pairing
  card show the edge URL.
- Verify: an anonymous upgrade request to `https://<public hostname>/bridge/ws`
  (`Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Version: 13`,
  `Sec-WebSocket-Key`) answers `101`; `https://<public hostname>/ide` without
  credentials still answers `401`.

## Deploy

```
ssh <user>@<station> bash -lc '/opt/ai/local-studio/scripts/deploy-spark.sh'
```

`scripts/deploy-spark.sh` is idempotent and builds out of place: fast-forward
`spark`, add a throwaway git worktree of the checkout at HEAD under
`/opt/ai/local-studio-build/<sha>`, `npm run setup` + `npm run build` in it
(the frontend build also bundles the runtime). The live tree is untouched during the build, so the
site keeps answering from the previous build. Then, in one `mv` each,
`frontend/.next`, `frontend/node_modules`, `services/agent-runtime/dist` and
`services/agent-runtime/node_modules` are moved to `.prev` and the built ones
put in their place, `localstudio-frontend` is restarted, and `/health` on 8081
and `/ide` on 4783 (production Host header, read from `.env.local`) are
checked. A failed build leaves the live tree and the unit alone (the build
tree is kept for inspection, the next run replaces it); a failed health check
moves the `.prev` outputs back and restarts. On success the worktree and the
`.prev` copies are removed. A lock (`/opt/ai/local-studio-build/.lock`) makes
a second concurrent run exit with a message instead of racing. Budget about
four minutes, with the site up throughout except for the restart. `--dry-run`
prints the steps, `--no-pull` builds the checkout as is. The registry token
for `@metactivity/*` is read from `/etc/ai/tuum-web.env` when
`NODE_AUTH_TOKEN` is not already set. The controller is not touched (restart
it by hand when `controller/` changed).

Rollback by hand: `git -C /opt/ai/local-studio checkout <previous sha>` then
`scripts/deploy-spark.sh --no-pull`.

The checkout is not a dev box: it must stay clean (`git status`), untracked
files aside. Discard local noise (`git checkout -- frontend/package-lock.json`)
before a pull that would otherwise refuse to fast-forward.

Tuum server (`/opt/tuum/server/<commit>`, `current` symlink): built on the
station from the `tuum` checkout with `make ide-server`; see
`docs/ide/strategie-fork-code-oss.md` §4 there for the reh-web step of a
Code-OSS rebase.

## Rebasing `spark` on upstream `main`

`spark` = upstream `main` + our commits. Upstream is the `upstream` remote.

1. `git fetch upstream && git rebase upstream/main` on a work branch.
2. Conflict policy: **upstream wins** in `controller/` and in upstream
   frontend modules; **ours re-applied** in `services/agent-runtime/`,
   `frontend/src/features/ide`, `frontend/src/features/ace`,
   `frontend/src/app/ide`, `shared/agent/workspace-identity.ts`,
   `frontend/public/tuum/`, and the gates in `frontend/desktop/automation/`.
3. `node scripts/project.mjs check` (the same gates CI runs on `spark`
   PRs: `agent-runtime`, `frontend`, structure gates; `desktop-package` is
   skipped on this line).
4. PR to `spark`, merge, deploy with the script.

## Bumping `@metactivity/*`

The runtime pins `@metactivity/ace`, `protocol`, `runtime` (and `sessions`
transitively) to exact versions published from the `tuum` repository
(`packages-publish.yml`, tag `ace-v*`). To bump: edit the versions in
`services/agent-runtime/package.json`, `bun install` with `NODE_AUTH_TOKEN`
exported (a read token for GitHub Packages, from the env file — never
committed), commit `bun.lock`, run the gates, PR. CI reads the same token from
the `NODE_AUTH_TOKEN` repository secret; the station reads it from
`/etc/ai/tuum-web.env`.

## Retired

- `~/.pi/agent` (pi-coding-agent config, skills, agents): archived as
  `~/.pi-agent.retired-<date>.tar.gz`; the runtime's agent dir is
  `~/.local-studio/pi-agent`.
- Desktop packaging (`desktop-package` CI job, `install-desktop-app.sh`): not
  run for `spark`.
- Edge auth is basic auth at the proxy; a Local Studio session cookie at the
  edge is a separate ticket.
