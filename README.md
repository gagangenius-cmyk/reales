# Reales - UAE enterprise real-estate CRM

Multi-tenant real-estate operating system (CRM, inventory, brokerage, property management, compliance, automation).
See [docs/PROGRESS.md](docs/PROGRESS.md) for what is built.

## Quick start

```bash
cp .env.example .env          # then fill AUTH_PEPPER and FIELD_ENCRYPTION_KEY (see comments)
npm install
npm run infra:up              # MySQL :3307, Redis :6380
npm run db:migrate
npm run db:seed               # prints demo credentials once
npm run dev                   # http://localhost:3000  (workspace: demo)
npm run worker                # outbox dispatcher -> BullMQ
npm test                      # needs the test DB (created by the compose init script)
```

## Layout

- `apps/web` Next.js UI and `/api/v1` routes; `apps/worker` outbox dispatcher and queue consumers
- `packages/database` connection, models, tenant-scoped repository, audit; `packages/domain` services (unit of work: change + audit + event in one transaction)
- `packages/auth`, `packages/rbac`, `packages/events`, `packages/observability`, `packages/validation`
- `migrations/` bounded, reviewable Sequelize migrations

## Rules that must not be broken

1. Tenant id comes only from the authenticated session, never from a request body, query or header.
2. Tenant-owned tables are accessed only through `TenantRepository`. New tables must be registered in `packages/database/src/models.ts`; the schema-guard test fails otherwise.
3. Every privileged mutation runs in `withUow`, so the change, its audit entry and its outbox event commit together.
4. Business deadlines live in the database, not in queue timers.
