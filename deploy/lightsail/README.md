# Lightsail runtime

This stack runs the always-on runtime on one Lightsail VM:

- `trueforge`: distributed TrueForge API/UI (`STANDALONE=false`) backed by Postgres
- `worker`: BullMQ consumer for Mission Control
- `postgres`: persistent Docker volume for TrueForge state
- `caddy`: HTTPS reverse proxy for the public TrueForge endpoint

The stack reuses the hosted `REDIS_URL` and `CONVEX_URL`. Runtime secrets belong only in `deploy/lightsail/.env` on the VM; do not commit that file.

## Current deployment

- Region: `ap-south-1` (Mumbai)
- Instance: `mission-control-agents`
- Static IP: `13.205.13.2`
- TrueForge: `https://trueforge.13-205-13-2.sslip.io`

## Update the VM

From the repository root, copy the source bundle to `/opt/mission-control`, update the VM-only `.env`, and run:

```bash
docker compose --env-file deploy/lightsail/.env \
  -f deploy/lightsail/compose.yaml up -d --build
```

The Lightsail firewall exposes only HTTP/HTTPS publicly; SSH is restricted to the deployer's current IP. Containers use `restart: unless-stopped` so the worker and TrueForge return after a VM reboot.
