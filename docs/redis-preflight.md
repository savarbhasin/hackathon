# Redis runtime: local development service and preflight

BullMQ requires a real Redis (RESP over TCP) instance with `maxmemory-policy=noeviction`. Queue keys are durable state — eviction silently corrupts the `agent-runs` queue. This document covers the repository's compose service and the credential-safe preflight check.

## Files

- `docker-compose.yml` — local Redis 7 (`mission-control-redis` container on host port 6390), `noeviction`, healthcheck.
- `scripts/redis-preflight.mjs` — dependency-free Node readiness check.

## Local development

```bash
docker compose up -d          # starts mission-control-redis on 127.0.0.1:6390
docker compose ps             # wait for healthy
node scripts/redis-preflight.mjs --mode local --url redis://127.0.0.1:6390
```

Set `REDIS_URL` in `.env.local` for application processes:

```bash
# .env.local (never commit real credentials)
REDIS_URL=redis://127.0.0.1:6390
```

The compose service disables RDB/AOF persistence on purpose: it is a development instance, and BullMQ recovers in-flight jobs by design (at-least-once delivery). Production Redis must have persistence enabled at the provider.

## Managed Redis / Upstash

Upstash exposes two endpoints. Only the **TCP endpoint** works with BullMQ:

- Use: `rediss://default:<PASSWORD>@<instance>.upstash.io:6379` (note `rediss`, TLS required).
- Do not use: `UPSTASH_REDIS_REST_URL` / REST token — REST cannot serve BullMQ's blocking pops, Lua scripts, or pub/sub.

```bash
export REDIS_URL='rediss://default:<PASSWORD>@<instance>.upstash.io:6379'
node scripts/redis-preflight.mjs              # managed mode is the default
```

Managed mode enforces `rediss://` plus an in-URL password before connecting.

## What the preflight checks

1. URL scheme valid for the selected mode (`--mode managed|local`).
2. TLS connection (certificate verified) or plain TCP for local.
3. `AUTH` accepted when the URL carries credentials.
4. `PING` → `PONG`.
5. `maxmemory-policy == noeviction`, read via `CONFIG GET` with an `INFO memory` fallback (Upstash denies/empties `CONFIG GET`; its policy surfaces as `maxmemory_policy` in `INFO memory`). A mismatch exits nonzero.
6. Reports `redis_version` informationally.

## Credential safety

- The script never prints the password, full URL with credentials, or AUTH arguments. Errors are passed through a redaction filter that strips the password from any provider message.
- Output identifies the target as `scheme//host:port` only.
- Keep real URLs in `.env.local` (gitignored) or shell environment variables — never in committed files.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All checks passed |
| 1 | Check failed or Redis returned an error |
| 2 | Usage/configuration error (no URL, unparseable URL, connect timeout) |

## BullMQ connection notes (Phase 1 worker)

- Worker and QueueEvents connections must set `maxRetriesPerRequest: null`.
- Blocking commands need long-lived connections; serverless/idle-killing proxies are incompatible.
- Verify the managed plan allows `noeviction` (Upstash persistent databases default to it; confirm with this preflight).
