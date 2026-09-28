# Pi Control Center

A single-node operations dashboard for a Raspberry Pi: real host metrics, Docker containers and live logs, a persistent activity feed, and deployments of explicitly configured Compose applications. React + TypeScript + Vite + Tailwind + Lucide + Recharts, served by a Fastify/TypeScript backend using Dockerode. No database server, telemetry service, generic terminal, or external monitoring stack.

## Architecture

```text
Browser ── HTTPS / authenticated cookies ── Tunnel or Tailscale (optional)
                                             │ loopback HTTP
                                      Fastify + static React
                                        ├─ Docker socket
                                        ├─ read-only Linux host mounts
                                        ├─ trusted deployment repositories
                                        ├─ bounded JSON activity / deployment history
                                        └─ optional outbound n8n webhook
```

The API and browser share types in `shared/types.ts`. APIs live in `apps/server/src`; the UI lives in `apps/web/src`. SSE carries metrics, container snapshots, activity and deployment output. A separate SSE connection streams Docker logs, including multiplexed stdout/stderr. There is no browser-supplied command or path API.

Host metrics sample every two seconds; Docker state/stats every five seconds after the previous collection completes. Charts retain 180 samples in memory (about six minutes). CPU percentages need two samples. Activity retains the latest 500 entries in an atomically replaced JSON file; deployments retain their last status and 64 KB of output per application. Sessions and charts reset on server restart. No fake metrics are shown when data is unavailable.

## Production setup on a Raspberry Pi

Use a **64-bit Linux OS** (for example Raspberry Pi OS Lite 64-bit), Docker Engine with Compose v2, and enough free storage for your images. The production image uses multi-architecture Node, Docker CLI and Compose images and builds natively on ARM64. Docker Desktop is useful for development but is not the production host-metrics target.

From this repository on the Pi:

```sh
cp .env.example .env
chmod 600 .env
mkdir -p data
id -u
id -g
stat -c '%g' /var/run/docker.sock
openssl rand -hex 32
```

Put the three numeric IDs into `PUID`, `PGID`, and `DOCKER_GID`. Put the random output into `SESSION_SECRET`. `data/` must be writable by `PUID:PGID` (if using different IDs: `sudo chown -R <uid>:<gid> data`). Configuration and repositories must be readable by that user. Generate an admin password hash as described below, put it in `ADMIN_PASSWORD_HASH`, and set `ADMIN_USERNAME`.

The default configuration is **local access only** at `http://localhost:3000`, with insecure cookies permitted only for a localhost origin. To use it from your laptop before setting up HTTPS, forward the loopback port:

```sh
ssh -L 3000:127.0.0.1:3000 your-user@raspberrypi
```

Open `http://localhost:3000` on the laptop. For remote HTTPS access set `PUBLIC_ORIGIN=https://your-exact-hostname` and `COOKIE_SECURE=true`, then configure one of the options below. Origins must have no trailing slash. Do not open router ports for this service.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose logs -f control-center
```

The supplied Compose file uses Linux host networking and binds **127.0.0.1 only**. It publishes no ports and does not configure any public exposure. The container runs as your configured non-root UID, with the Docker socket group, all capabilities dropped, no-new-privileges, a read-only container filesystem, and a temporary `/tmp`. Repositories/data are the only intended writable mounts.

### Generate the password hash

The included script uses Node's scrypt (N=65536, r=8, p=1; 64 MB memory cost, salted 64-byte output). It reads the password from stdin, never from an argument. It requires at least 12 characters. In Bash on the Pi:

```sh
read -r -s -p 'Admin password: ' PI_ADMIN_PASSWORD; echo
printf '%s' "$PI_ADMIN_PASSWORD" | node scripts/hash-password.mjs
unset PI_ADMIN_PASSWORD
```

Node need not be installed on the host. Use the official Node container instead:

```sh
read -r -s -p 'Admin password: ' PI_ADMIN_PASSWORD; echo
printf '%s' "$PI_ADMIN_PASSWORD" | docker run --rm -i \
  -v "$PWD/scripts:/scripts:ro" node:22-alpine node /scripts/hash-password.mjs
unset PI_ADMIN_PASSWORD
```

Copy the single `scrypt:...` line into `.env`. Never put the plaintext password in `.env`, the shell command line, or Git. `npm run password:hash --silent` runs the same script when dependencies are installed.

## Development

Requires Node **22.22+** and npm. Linux is required for live `/proc` host metrics; on macOS/Windows the UI shows an explicit metrics error, not fabricated data. Docker controls can use an accessible local Unix Docker socket (for example `DOCKER_SOCKET=/Users/you/.docker/run/docker.sock` on macOS).

```sh
npm ci
cp .env.example .env
# Generate SESSION_SECRET and ADMIN_PASSWORD_HASH as above.
# Set PUBLIC_ORIGIN=http://localhost:5173 and COOKIE_SECURE=false.
npm run dev
# In another terminal:
npm run dev:web
```

Visit `http://localhost:5173`. Vite proxies `/api` (including SSE) to `127.0.0.1:3000`. The production server serves `dist/web` itself:

```sh
npm run lint
npm run typecheck
npm test
npm run build
# Set PUBLIC_ORIGIN=http://localhost:3000 for the production server locally.
npm start
```

Tests use Node's built-in test runner and Fastify injection. They cover authentication, authorization, cookies, CSRF, origin checks, login throttling, action/config allowlists, fixed command plans, and Linux metric parsing. The default tests do not need a real Docker daemon or production credentials. An opt-in integration test creates and removes only its own disposable container, exercises start/stop/restart, safe inspection, SSE and multiplexed logs:

```sh
docker pull node:22-alpine
# Set DOCKER_SOCKET if your development socket is elsewhere.
npm run test:docker
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default 3000 |
| `BIND_ADDRESS` | Direct Node bind address; supplied Compose forces loopback |
| `PUBLIC_ORIGIN` | Exact externally used browser origin, used for CSRF checks |
| `SESSION_SECRET` | At least 32 random characters; HMACs opaque server-side session IDs |
| `ADMIN_USERNAME` | Single administrator username |
| `ADMIN_PASSWORD_HASH` | Hash generated by the included scrypt script |
| `COOKIE_SECURE` | `true` for HTTPS; `false` permitted only with a localhost origin |
| `N8N_WEBHOOK_URL` | Optional HTTP(S) endpoint; empty disables events |
| `APPS_CONFIG_PATH` | Server-owned app JSON; Compose sets `/app/config/apps.json` |
| `DATA_DIR` | Writable history directory; Compose sets `/app/data` |
| `DOCKER_SOCKET` | Local Unix socket; Compose sets `/var/run/docker.sock` |
| `HOST_PROC`, `HOST_SYS`, `HOST_ROOT` | Host metric sources; Compose supplies read-only mounts |
| `TEMPERATURE_WARN` | High-temperature event threshold in °C, default 80 |
| `DISK_WARN_PERCENT` | Disk usage warning percentage, default 90 |
| `PUID`, `PGID`, `DOCKER_GID` | Compose runtime user/group/socket group IDs |
| `DEPLOY_HOME` | Optional dedicated CLI credentials directory; defaults to writable `/tmp`; optional `/deploy-home` mount for persistent CLI state |

Startup fails clearly on invalid secrets, origins, app configuration or unreadable history. `.env` is ignored by Git and excluded from Docker builds. Config changes require restarting the service. There is no settings API for retrieving or editing secrets.

## Add an application for deployment

First clone and check out a trusted repository on the Pi. Ensure its checkout belongs to the configured runtime UID and is on the intended branch with a clean working tree. Edit `config/apps.json`:

```json
{
  "apps": [
    {
      "id": "columbot",
      "name": "Columbot",
      "directory": "/srv/columbot",
      "composeFile": "docker-compose.yml",
      "branch": "main",
      "project": "columbot",
      "build": true
    }
  ]
}
```

`project` defaults to `id`. **Use the existing Compose project name** if the application already runs on the Pi, or Compose may create a second stack. Container association uses Docker's `com.docker.compose.project` label. `build` defaults to false. Build-only services should specify `pull_policy: build` in their Compose configuration so the pull step does not try to pull a nonexistent image. Configure healthchecks for services that must be ready before deployment succeeds.

Add the repository bind mount to `docker-compose.yml`:

```yaml
volumes:
  - /srv/columbot:/srv/columbot
```

The host path and container path must match: Compose resolves bind sources in the CLI container, while the host Docker daemon mounts those sources. Mount every application directory needed for deployment. A repository's `.env` is read by Compose from that repository, not from the Control Center's environment.

Restart the Control Center. Deploy performs these predefined steps:

1. Require a clean working tree, matching branch, and Compose file inside the configured directory (including symlink checks after Git updates).
2. `git fetch --prune origin <configured branch>`.
3. `git merge --ff-only refs/remotes/origin/<configured branch>`; never reset/discard local commits or changes.
4. `docker compose --project-name <project> --file <file> pull`.
5. The same `compose build` if configured.
6. The same `compose up -d --wait --wait-timeout 120`.
7. Verify that associated containers are running and none is unhealthy; refresh the checked-out commit and record the outcome.

The dashboard receives bounded live output. One deployment at a time protects Pi resources. Each command has a ten-minute timeout and a timed-out process group is killed. Failed deployment output is retained; there is **no automatic rollback**. The recorded commit is the checked-out commit, which may differ from the running application after a failed build. Fix the error and redeploy. A server restart marks interrupted deployments failed.

For private repositories over SSH, use `PUID=1000` (the image’s named `node` user) and mount a dedicated SSH directory at `/home/node/.ssh:ro`, containing a config, key and pinned `known_hosts`. OpenSSH uses the passwd home directory, not the deployment HOME setting. Other UIDs need a corresponding named user in a customized image for SSH. For registry authentication, set `DEPLOY_HOME=/deploy-home` and mount a dedicated **writable** directory there with a narrowly scoped `.docker/config.json`; Buildx also writes CLI state under this home. Without credentials, the default `/tmp` home supports public repositories and builds. Do not mount your entire home. Commands are noninteractive; missing credentials fail. The container UID must own/read keys and own writable CLI state. Git system/global configuration is disabled; repository-local configuration remains trusted.

**Trust boundary:** deploying a repository executes its Dockerfile/build hooks and Compose configuration with Docker access. Only deploy repositories and branches you trust, protect write access to `apps.json`, and limit who can push to those branches. Server-side allowlists prevent browser command injection; they do not sandbox malicious repository code.

## Host metrics inside Docker

The supplied Compose configuration reads host `/proc`, `/sys`, and `/` through read-only mounts. CPU uses deltas of `/proc/stat`; RAM uses `MemTotal - MemAvailable`; load and uptime use host counters; temperature checks CPU/SoC thermal zones; disk reports the filesystem containing host `/`. Network mode `host` ensures `/proc/net/dev` and interface IPs reflect host networking rather than an isolated container namespace. Loopback, `veth`, `docker*` and `br-*` interfaces are excluded to avoid common double-counting. VPN interfaces may still overlap physical traffic. Network chart values are bytes per second; container network values are cumulative bytes.

The host root mount is broad, read-only, and needed for root filesystem capacity and `/etc/os-release`. The backend exposes no file-reading endpoint. A backend compromise can nevertheless read host files allowed by its UID. These mounts and the socket are a deliberate privilege tradeoff; run this only on a Pi you administer. Other disks are not aggregated. Missing thermal sensors/statfs return unavailable values. Host throttling, GPU memory and per-core history are not implemented.

## Docker permissions and security

**Docker socket access is effectively host-root authority.** Non-root execution, a read-only mount, or a read-only container filesystem does not make the Docker API harmless: a process with socket access can ask the daemon to mount host paths or start privileged containers. Do not expose this service unauthenticated or to untrusted users. The socket is explicitly mounted read-write because start/stop/restart/deploy require management access. Never fix permission errors with `chmod 666` on the socket; use its actual group ID.

The backend uses random opaque eight-hour sessions stored in memory (maximum 20), HTTP-only SameSite=Strict cookies, secure cookies on HTTPS, same-origin checks for every mutation including login, and per-session CSRF tokens. Logout invalidates the session and open streams are rechecked every 15 seconds. Login is limited to five attempts per minute per direct peer; API requests are rate-limited. Forwarded IP headers are deliberately not trusted, so clients behind the same tunnel share a rate-limit bucket. Use Cloudflare Access or tailnet policy as an additional access boundary.

Docker API exposure is restricted to discovery/stats/details/logs, start/stop/restart, and dangling-image cleanup. Inspection returns only an explicit safe subset and environment **names**, never values or raw inspect data. Stop/restart/deploy/cleanup require UI confirmation. The backend validates IDs, actions, payloads and configured application identifiers. It never accepts command strings, shell arguments, directories or Compose paths from the browser. Child processes use argument arrays and `shell: false`, and do not inherit the app's password/session/webhook environment variables.

**Logs and build output can contain secrets emitted by your applications.** This tool does not attempt unreliable generic redaction; only the authenticated administrator can read these streams. Avoid logging secrets in applications. Persisted deployment output may contain them; protect/back up `data/` accordingly. The service itself does not log login request bodies or cookies. Consider disk encryption and backups for credentials/history. Dangling-image cleanup is destructive and has a confirmation dialog; it does not prune volumes or tagged images.

## Optional n8n integration

Set `N8N_WEBHOOK_URL` to an n8n production webhook URL. Events are best-effort POSTs with a five-second timeout and at most four concurrent deliveries; webhook outages do not block operations. There is no durable delivery queue or retry guarantee. The URL is never sent to the browser or logged on delivery failure.

```json
{
  "type": "deployment.completed",
  "timestamp": "2026-09-28T17:00:00.000Z",
  "source": "pi-control-center",
  "data": { "message": "Columbot deployed successfully", "level": "success" }
}
```

Events include `container.unhealthy`, `container.crashed`, `deployment.started`, `deployment.failed`, `deployment.completed`, `system.temperature.high`, and `system.disk.low`. Resource alerts trigger on threshold crossings, not every sample. Crash/restart detection compares Docker samples, so very short-lived transitions between samples can be missed. Use HTTPS for webhooks crossing untrusted networks.

## Remote access

### Cloudflare Tunnel

Run `cloudflared` on the host and route your hostname to `http://127.0.0.1:3000`. A locally managed tunnel configuration can contain:

```yaml
tunnel: YOUR-TUNNEL-UUID
credentials-file: /etc/cloudflared/YOUR-TUNNEL-UUID.json
ingress:
  - hostname: pi.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Set `PUBLIC_ORIGIN=https://pi.example.com` and `COOKIE_SECURE=true`; recreate the Control Center with `docker compose up -d`. Protect the hostname with a Cloudflare Access policy in addition to app authentication. Do not cache `/api/*` or buffer SSE. Refer to the official [tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) and [configuration format](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/). If cloudflared itself is containerized, use Linux host networking so its loopback resolves to this host service.

### Tailscale alternative

Install/authenticate Tailscale on the Pi and your client devices, then proxy the loopback server privately:

```sh
sudo tailscale serve --bg http://127.0.0.1:3000
```

Use the HTTPS URL printed by Tailscale as `PUBLIC_ORIGIN` and set `COOKIE_SECURE=true`; recreate the Control Center. Restrict access using your tailnet policies. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) shares within your tailnet; do not enable Funnel unless you deliberately want public exposure. Neither remote-access product is required for local use.

## Updating and recovery

Back up `.env`, `config/`, and `data/` securely. Update the checkout yourself, then:

```sh
docker compose up -d --build
docker compose logs --tail 100 control-center
```

A rebuild/restart expires all sessions; sign in again. Keep a separate SSH path for recovery, especially if managing the Control Center's own container. Stopping it from the dashboard stops the dashboard too; start it again through SSH. Changing a password hash requires a restart, invalidating all sessions. Restore prior source/image versions and backed-up data if an update fails. Deployments do not automatically roll back applications.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup validation error | Replace placeholders; exact origin without slash; correct hash format; readable JSON config |
| Login fails / cookie missing | Correct origin, HTTPS when secure cookies are on, browser hostname matches PUBLIC_ORIGIN; wait one minute after rate limiting |
| `Origin not allowed` | `localhost` and `127.0.0.1` are different origins; use the configured one. Dev Vite uses port 5173 |
| Docker unavailable / permission denied | Daemon running, socket mounted, numeric DOCKER_GID matches `stat -c '%g' /var/run/docker.sock` |
| History cannot be written | Ensure `data/` belongs to configured PUID:PGID and filesystem has free space |
| Metrics unavailable / container-like network | Linux host mounts and host networking must be present; macOS direct Node execution lacks Linux metrics |
| No temperature | Kernel thermal driver/sensor missing or inaccessible; shown as unavailable |
| Container CPU initially blank | Wait for two successful Docker samples (about 10 seconds) |
| Deployment checkout error | Mount repo at identical host/container path, match ownership and branch, clean working tree, valid remote credentials |
| Git dubious ownership | Match runtime PUID to checkout owner; do not globally disable Git's ownership checks |
| Compose pull fails for a local build | Use `pull_policy: build` for build-only services and `build: true` in apps.json |
| Compose health wait fails | Inspect service logs and healthchecks; no-healthcheck services are checked for running state only |
| SSE reconnecting / stale data | Backend up, proxy buffering/cache disabled, streaming allowed; 12 concurrent streams maximum; close unused tabs |
| Logs unavailable | Container may be removed, or its logging driver may not support Docker's logs API |
| n8n receives nothing | Production webhook active, reachable from host network; URL configured; inspect service logs for HTTP errors |

Logs retain a 250 KB browser buffer, support filtering/auto-scroll/clear, and request at most 2,000 historical lines. Pausing closes the log connection; resuming starts from now, so output emitted during a pause is skipped. Change the history selector or reopen the viewer to reload recent lines.
