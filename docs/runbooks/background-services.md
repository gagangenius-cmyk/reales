# Background services (scheduler and worker)

The web app (Vercel) only answers requests. Two long-running processes do the rest of the work:

| Service | Does | Needs |
|---|---|---|
| scheduler (`npm run scheduler`) | every minute: expiry sweeps, workflow waits, campaign batches, SLA, e-mail queue, outbound webhook delivery, Google sync, claim due notices | database |
| worker (`npm run worker`) | publishes outbox events, runs workflow triggers, processes provider webhooks | database, Redis |

## Deploy
Any always-on host with Docker (a small VPS is enough): see `infrastructure/docker-compose.background.yml`. Use the same environment values as the web app. On Kubernetes use the Helm chart (`infrastructure/helm/reales`), which already has both roles.

## Is it running?
`GET /api/v1/health/background` returns 200 when both services reported in during the last 5 minutes and 503 otherwise, with the age of each last heartbeat. Point an uptime monitor (UptimeRobot, Better Stack, Pingdom) at it and alert on non-200.

## If it is down
Work is not lost: events wait in the outbox, queued e-mail and webhook deliveries stay pending, and sweeps are idempotent. Restart the service and the backlog drains. Time-based work (expiries, SLAs) is applied at the next pass.

## Needs migration 073 (`service_heartbeats`)
Until `npm run db:migrate` has run, the services work but report nothing and the health endpoint answers 503.
