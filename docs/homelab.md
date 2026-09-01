# Homelab / Remote Server Mode

Run Preflight as a shared event-collection server — multiple developers forward
their session data to one box, which accumulates it into standard session-store
files, no New Relic account required.

**Current scope: this is ingest-only.** The server accepts and persists events;
it does not yet serve a dashboard for viewing the aggregated data. Dashboard
viewing (with proper per-route authentication) is tracked as a follow-up — see
[issue #514](https://github.com/newrelic-experimental/preflight/issues/514)
for status. Until then, the accumulated session files
(`<storage>/sessions/*.json`) can be inspected directly on the server, or copied
to a machine running `preflight --local` against that storage path.

## Architecture

Each developer's machine runs as it does today (local MCP tools, optional NR cloud).
When `homelabServerUrl` is configured, the local MCP server also forwards a copy of
every hook event to the homelab server via `POST /ingest`.

The homelab server accumulates events per session and periodically saves session
summaries to disk in the same format used by `preflight --local`.

## Server Setup (one-time)

### With Docker Compose (recommended)

```bash
# 1. Clone the repo on the homelab box
git clone https://github.com/newrelic-experimental/preflight
cd preflight

# 2. Build
npm install && npm run build

# 3. Set a secret token
cp .env.example .env
# Edit .env — replace PREFLIGHT_TOKEN with a strong random value, e.g.:
# PREFLIGHT_TOKEN=$(openssl rand -hex 32)

# 4. Start
docker compose up -d

# 5. Verify
curl http://localhost:7777/api/health
```

The server persists session data in the `preflight-data` Docker volume
(`/root/.newrelic-preflight` inside the container).

### Without Docker

```bash
NEW_RELIC_AI_HOMELAB_TOKEN=<your-secret> \
  node dist/index.js server --port 7777
```

## Developer Client Setup (one-time per developer)

There's no interactive setup-wizard support for these fields yet (`preflight setup`
doesn't prompt for them) — edit the config file or environment directly.

Add to `~/.newrelic-preflight/config.json`:

```json
{
  "homelabServerUrl": "http://homelab:7777",
  "homelabToken": "your-secret-here"
}
```

Or export the equivalent environment variables wherever the MCP server process
itself inherits its environment (e.g. your shell profile, or the environment
Claude Code's hooks run under) — the config loader reads these on every boot, so
they must be present when `preflight` actually starts, not just on a one-off
command line:

```bash
NEW_RELIC_AI_HOMELAB_URL=http://<homelab-ip>:7777
NEW_RELIC_AI_HOMELAB_TOKEN=<your-secret>
```

## Configuration Reference

### Client fields (on each developer's machine)

| Config key         | Env var                      | Purpose                   |
| ------------------ | ---------------------------- | ------------------------- |
| `homelabServerUrl` | `NEW_RELIC_AI_HOMELAB_URL`   | URL of the homelab server |
| `homelabToken`     | `NEW_RELIC_AI_HOMELAB_TOKEN` | Shared bearer token       |

### Server fields (on the homelab box)

| Config key                  | Env var                             | Default   | Purpose      |
| --------------------------- | ----------------------------------- | --------- | ------------ |
| `homelabServer.port`        | `NEW_RELIC_AI_HOMELAB_SERVER_PORT`  | `7777`    | Port to bind |
| `homelabServer.bindAddress` | `NEW_RELIC_AI_HOMELAB_BIND_ADDRESS` | `0.0.0.0` | Bind address |

The server binds all interfaces by default so remote clients can reach it. The
only access control today is the single shared bearer token on `/ingest` — there
is no per-developer credential and no dashboard exposed. Bind to a trusted
network/VPN interface if that matters for your deployment.

`homelabServerUrl` is expected to point at a private LAN address — that's the
whole point of this feature — so the client's outbound connection intentionally
allows RFC-1918/loopback destinations. It still refuses to connect to cloud
metadata endpoints (e.g. AWS/GCP/Azure's `169.254.169.254`) even if one is
configured or a DNS response resolves there, and only accepts `http:`/`https:`.

## Smoke Test

After starting the server, verify it works:

```bash
# Health check (no auth required)
curl http://<homelab>:7777/api/health

# Test auth rejection
curl -s -o /dev/null -w "%{http_code}" -X POST http://<homelab>:7777/ingest \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"developer":"test","sessionId":"test","records":[]}'
# Expected: 401

# Test valid ingest
curl -s -o /dev/null -w "%{http_code}" -X POST http://<homelab>:7777/ingest \
  -H "Authorization: Bearer <your-secret>" \
  -H "Content-Type: application/json" \
  -d '{"developer":"test","sessionId":"test-abc","records":[{"id":"1","sessionId":"test-abc","toolName":"Read","toolUseId":"u1","timestamp":1000,"durationMs":1,"success":true}]}'
# Expected: 204
```

## Troubleshooting

**No session files appear after forwarding events**

Sessions are flushed to disk when they go 3 minutes without new events (or on server shutdown). Wait a few minutes after your last tool call, then check `<storage>/sessions/` on the homelab box.

**`401 Unauthorized` from `/ingest`**

The token on the client (`NEW_RELIC_AI_HOMELAB_TOKEN`) doesn't match the server token (`PREFLIGHT_TOKEN` in `.env`). Fix the client's `homelabToken` in `~/.newrelic-preflight/config.json` (or the equivalent environment variable) and restart the MCP server.

**`ECONNREFUSED` in MCP server logs**

The homelab server is unreachable. Check that the server is running (`docker compose ps`), the port is open in your firewall, and the URL in `homelabServerUrl` is correct. Forwarding failures are non-fatal — local MCP tools continue working.
