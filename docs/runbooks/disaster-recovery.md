# Disaster recovery runbook

Status: **draft procedure; targets are goals, not measured guarantees.** The first restore drill result must replace the placeholders below.

## Objectives (to be agreed with the business and then measured)

| | Target | Measured |
|---|---|---|
| RPO (data loss) | <= 5 minutes (managed-DB point-in-time restore) | _fill in after first drill_ |
| RTO (time to serve again) | <= 4 hours | _fill in after first drill_ |

`scripts/restore-drill.sh` prints the elapsed time of a logical restore; point-in-time restore of the managed database needs its own timed drill.

## What is backed up

| Data | Mechanism | Retention |
|---|---|---|
| MySQL (all tenants) | Managed automated backups + PITR (see `infrastructure/terraform`), plus a nightly logical dump from `scripts/backup.sh` | 14 days managed, 30 days logical (set by you) |
| Documents / uploads | Object storage with versioning and KMS encryption | Non-current versions 365 days |
| Redis | Not a system of record. Queues are rebuilt from the transactional outbox; rate-limit counters are disposable | n/a |
| Secrets and keys | Secret manager. **`FIELD_ENCRYPTION_KEY` loss makes encrypted KYC/MFA fields unrecoverable**: escrow it separately | n/a |

Backups stay in-region. Cross-region copies are deliberately not configured; enable them only if the tenant data-processing policy permits.

## Restore drill (monthly)

1. `scripts/backup.sh` (or pick the latest managed snapshot and restore it to a new instance).
2. `scripts/restore-drill.sh` against a throwaway database. It fails if tables or append-only triggers are missing.
3. Run `verifyAuditChain` for a sample of tenants against the restored database (the hash chain must verify end to end).
4. Record elapsed time and any manual step in the table above. Delete the throwaway database.

## Incident: database lost or corrupted

1. Declare an incident; stop writers: scale `reales-web`, `reales-worker`, `reales-scheduler` to 0.
2. Restore to a **new** instance (point-in-time just before the fault if it was logical corruption; latest snapshot if infrastructure loss).
3. Run `npm run db:migrate` (forward-only, idempotent) against the new instance.
4. Verify: tenant count, `verifyAuditChain` on a sample, and a read of recent leads/deals.
5. Point `DB_HOST` at the new instance; scale the scheduler first, then worker, then web.
6. Events written after the restore point are lost; business deadlines (offers, reservations, rent, SLAs, DSR clocks) live in the database and resume from restored state. Reconcile payments and e-signature callbacks with the providers for the gap window (webhooks are deduplicated, so replaying them is safe).

## Incident: cache/queue lost

Redis loss is not data loss. Restart Redis; the worker re-dispatches pending outbox rows (`FOR UPDATE SKIP LOCKED`, at-least-once). Consumers are idempotent.

## Incident: region unavailable

There is no automatic multi-region failover (single in-country region by design). Recovery is a restore into another UAE-resident environment if one exists; otherwise wait for the region. Decide this trade-off with the business: it is a data-residency versus availability choice, not a technical default.

## Secret and key rotation

* `AUTH_PEPPER`: rotating invalidates all password hashes if the pepper is part of them; plan a forced reset.
* `FIELD_ENCRYPTION_KEY`: requires re-encrypting `mfa_methods.secret_encrypted`, `kyc_profiles.id_number_enc/date_of_birth_enc`, `sso_connections.client_secret_enc`, `sso_states.code_verifier_enc` (envelope encryption with a KMS key id per row is the recommended next step; not implemented).
* SSO client secrets: rotate at the identity provider, update the connection.

## Contacts and comms

Fill in: incident commander, DBA, security officer, customer-communication owner, regulator-notification owner (data-breach notification duties come from the applicable law and customer contracts; confirm with counsel).
