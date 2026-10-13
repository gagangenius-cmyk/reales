# Progress

Source of truth: the UAE Enterprise Real Estate CRM blueprint (PDF) and `C:\Users\97154\.claude\plans\read-complete-pdf-start-refactored-graham.md`.

Legend: **Real** = implemented and tested. **Mock** = interface plus a stand-in implementation. **Deferred** = not started.

## Phase 1 - Foundation: DONE

| Area | Status | Notes |
|---|---|---|
| Monorepo, TS, CI workflow | Real | `.github/workflows/ci.yml` (not yet run on a remote) |
| Docker Compose: MySQL 8.4, Redis 7 | Real | Ports 3307 / 6380 to avoid clashing with XAMPP and local Redis |
| Docker Compose: MinIO | Deferred | Image could not be pulled (Docker Hub and quay.io both refused). Opt-in profile `storage`; dev will use a local-filesystem driver until phase 3 |
| Migrations 001-007, 041-043 | Real | Reproducible from zero (the test run rebuilds the schema every time). Blueprint numbering kept, so 008-040 slot in later |
| Tenancy (tenants, settings, jurisdiction, data region) | Real | `jurisdiction` and `data_region` are first-class columns |
| Plans, entitlements, quotas, usage meters | Real (schema, quota enforcement on users) | Metering and billing are deferred |
| Identity: users, profiles, sessions | Real | Opaque session secret (sha256 stored), 8h sliding expiry, lockout after 5 failures |
| MFA: TOTP, recovery codes, replay protection, step-up | Real | Secrets AES-256-GCM encrypted; privileged roles must enrol |
| RBAC: roles + scopes + explicit permissions | Real | Scopes tenant / business_unit / branch / project / portfolio / own_records, with anchors. Escalation guards on role assignment |
| Org structure, projects | Real | Business units, branches, teams, projects/portfolios |
| Audit log | Real | Append-only (DB triggers), hash-chained per tenant, verified by `verifyAuditChain` |
| Transactional outbox + dispatcher | Real | `FOR UPDATE SKIP LOCKED`, backoff, at-least-once; BullMQ publisher in `apps/worker` |
| Idempotency keys | Real | Replay, mismatch (422), in-progress (409), failure releases the key |
| API layer | Real | Correlation ids, Origin check (CSRF), per-IP and per-tenant rate limits, Zod validation, error mapping |
| Web UI | Real (minimal) | Login, MFA setup, dashboard, projects, organization, users, audit |
| OpenTelemetry | Partial | API spans helper exists (`withSpan`); no SDK/exporter registered yet |
| Kubernetes / Terraform / Helm | Deferred | Phase 8 |

### Known limitations (deliberate, tracked)
- Password reset, invitations by email, and user-facing session management pages are not built yet (API for sessions exists).
- Rate limiter falls back to per-process memory when Redis is unreachable.
- CSP allows `unsafe-inline` scripts for Next bootstrap; move to nonces before production.
- Field encryption uses a single env key; swap for KMS envelope encryption before production.
- `TRUST_PROXY=1` must be set behind a trusted proxy for correct client IPs.

### Verification
`npm run infra:up && npm run db:migrate && npm test` - 121 tests across isolation, auth, RBAC, audit, outbox, idempotency, contacts/consent, leads/routing, listing compliance, viewings/offers/deals/commissions, documents/e-sign, finance, sweeps, API and worker. `npm run test:isolation` is the release-blocking subset (repository, schema guard, DB-enforced referential integrity).

## Phase 2 - Brokerage core: DONE

| Area | Status | Notes |
|---|---|---|
| Contacts, organizations | Real | E.164 phone and email normalisation (UAE formats), duplicate detection that never leaks contacts the caller cannot see |
| Consent, suppression | Real | Purpose + channel specific; immutable `consent_events` (DB triggers) with text hash, source, IP; single `evaluateContactability` gate; lifting a suppression needs step-up + reason + audit |
| Leads, sources, pipeline, stage history | Real | Explicit `lead_stage_events`; loss reason required; re-opening is a manager action; repeat enquiries collapse into the open lead |
| Lead routing | Real | Priority rules with conditions, round-robin / least-loaded, capacity caps, fallback to unassigned; row-locked so concurrent inbound leads distribute evenly (units of work run at READ COMMITTED) |
| Scoped visibility | Real | Generic `scopeWhere` turns grants (tenant / branch / business unit / project / own records, with anchors) into query filters; agents also see contacts of leads routed to them |
| Inventory | Real | Developers, projects (ready / off-plan, registration + escrow ref), buildings, units, status state machine with row lock; non-available units are auto-unpublished |
| Regulatory rules as data | Real (content illustrative) | `jurisdictions` / `regulatory_rules` / versioned definitions for DUBAI_MAINLAND, ABU_DHABI_MAINLAND, ADGM. **The seeded requirements are illustrative defaults and MUST be reviewed by a UAE real-estate compliance specialist before customer use** |
| Listing publication gate | Real | `publishable = permit valid && brokerage licence valid && agent licence valid && required fields && media && off-plan registration/escrow`, evaluated by date so expiry blocks; API returns the exact issues (422) |
| Portal publication | Real (export mode) | Canonical listing -> Bayut-style XML and Property Finder-style JSON; **append-only snapshot per portal per publish/update/unpublish**; manual-upload feed. Field mappings are illustrative, not verified portal contracts. Live `api` mode intentionally fails with an explanation until an authorised partner integration exists |
| Compliance sweep | Real | `unpublishNonCompliant` takes down listings whose permit/licence lapsed (deadlines live in the DB, to be run by the scheduler in a later phase) |
| DB-enforced tenant integrity | Real | Composite FKs `(tenant_id, x_id)` on the new tables: the database rejects cross-tenant references even if application code had a bug |
| API + UI | Real | 53 API routes total; pages for leads (with detail/stage/activity), contacts, inventory, listings (check/publish) |

### Deferred from Phase 2 (tracked)
- Public lead-capture endpoint with API keys (domain `ingestLead` exists; needs `api_keys` + webhook auth from phase 4).
- `contact_relationships`, tags, amenities/unit types, floors, opportunities (deals arrive in phase 3), duplicate-merge tool, routing-rule UI, media upload (needs the storage driver).
- Scheduler process that runs `unpublishNonCompliant` and SLA timers.
- DLD/Trakheesi/ADREC verification is manual (a verifier marks permits/licences valid); no government API is integrated.

## Phase 3 - Transaction management: DONE (with mock providers)

| Area | Status | Notes |
|---|---|---|
| Viewings | Real | Booking row-locks the agent, so concurrent requests cannot double-book; past/unavailable-unit checks; check-in, complete (feedback), cancel (reason), no-show |
| Offers | Real | Alternating buyer/seller counters, **append-only revision history**, acceptance is a manager approval that rejects rival offers in the same transaction, expiry sweep |
| Reservations | Real | DB-enforced "one active reservation per unit" (generated-column unique index) plus row lock; reserving a unit unpublishes its listing; cancel/expire releases the unit |
| Deals | Real | Stages reserved, contract, signed, payment, registration, closed. Sequential only; **gates** (deposit, signature, every instalment settled, plus a pluggable `registerDealGate` hook for the compliance phase) return 422 with the exact reasons; backwards moves and manual overrides are manager-only with a reason and audit; `deal_stage_events` is append-only; one open deal per unit (DB-enforced) |
| Payment plans | Real | Instalments as milestones, validated against the deal amount |
| Closing | Real | One transaction: unit sold/rented, lead marked won, commission calculated, audited, event emitted. Cancelling a deal that has received money is refused until refunds exist |
| Commissions | Real | Plans with splits; integer-fils arithmetic with largest-remainder allocation (no fils lost); approval needs `commission.approve` **and** a fresh second factor; agents see only their own |
| Documents | Real | Immutable versions, content-addressed storage (`tenant/sha256`), magic-byte type allow-list (PDF/PNG/JPEG/DOCX/XLSX; HTML/SVG/executables rejected), 25 MB cap, malware-scanner hook (`REQUIRE_MALWARE_SCANNER=1` refuses uploads without one), access follows the linked entity's scope, hash re-verified on every download, hardened download headers (attachment, nosniff, sandbox CSP) |
| E-signature | Real flow, **mock provider** | `SignatureProvider` interface; envelope pins the document version + content hash; ordered signers; completion re-verifies the hash (tamper detection) and stores an evidence package; completes the `contract_signed` milestone; append-only events. The provider is a development mock: **no real e-sign vendor is integrated, and a UAE-qualified/trust-service signature level has not been implemented** |
| Payments | Real flow, **mock provider** | `PaymentProvider` interface; recorded payments (bank transfer/cheque/cash) and provider payment links; receipts; allocation to invoices under an invoice row lock; an amount that differs from the request is never auto-accepted; completes the deposit milestone when the payment covers it |
| Invoices | Real | Gap-free per-tenant numbering (atomic counter), VAT per line (**rate is an explicit input; 5% default must be confirmed by finance per supply type**), issued invoices frozen, void needs a reason and is refused once paid |
| Webhook pipeline | Real | Signature verified over the RAW body (constant-time HMAC) -> dedupe on provider event id -> raw event persisted -> acknowledged -> processed asynchronously by the worker via the outbox (`WEBHOOK_PROCESS_INLINE=1` for dev). Forged/tampered bodies are rejected and nothing is stored |
| Deadline sweeps | Real | `apps/scheduler` runs `runSweeps` per tenant: expire offers and reservations, unpublish listings whose permit/licence lapsed. Idempotent, isolated per tenant, audited as `system` |
| Reliability | Real | Units of work retry on MySQL deadlocks; lock order is invoice -> payment -> counters |
| API + UI | Real | 42 new route files (viewings, offers, reservations, deals, documents with multipart upload, signature envelopes, invoices, payments, payment links, commissions, webhooks); pages for viewings, deals (with stage and milestone actions and blocking reasons), finance |

### Deferred from Phase 3 (tracked)
- A real e-signature vendor and a UAE trust-service (qualified) signature option; provider-side evidence download.
- A real payment gateway, refunds, reconciliation against bank statements, payment-link emails.
- Developer-side off-plan payment plans with escrow release rules; SPA/Oqood registration steps as configurable templates (rules-as-data like the listing gate).
- Deal documents generated from templates (phase 4 template engine); document expiry/legal hold.
- S3/MinIO storage driver (local filesystem driver in use), ClamAV scanner implementation.
- Commission clawbacks, team overrides, payouts.
- Owner statements and ledger export to accounting (phase 5/8).

## Phase 4 - Communication and automation: DONE (mock messaging provider)

| Area | Status | Notes |
|---|---|---|
| Templates | Real | Per-channel editors and validation (email: subject/body, no scripts or header injection; WhatsApp: structured body/header/footer/buttons with Meta-style limits; SMS: GSM-7/UCS-2 segment counting, Arabic aware). Immutable versions (DB blocks deletes); WhatsApp versions need approval by a different person and an edit withdraws approval. Unlayer embedded designer for email (design JSON = source, exported HTML = snapshot) - needs Unlayer account/licence configuration before production |
| Variable resolver | Real | Allow-listed catalogue only, own-property lookups (a test caught `contact.constructor` resolving through the prototype chain - fixed), missing values throw instead of sending blanks, HTML values escaped |
| Inbox and messaging | Real flow, **mock provider** | `MessagingProvider` interface; one outbound path (`sendMessage`) enforcing idempotency, consent/suppression, the WhatsApp 24h session rule and approved templates; provider call happens outside any DB transaction; retryable failures resume under the same key without duplicating; inbound routed to the tenant by receiving number; STOP / Arabic opt-out keywords revoke consent and suppress instantly; delivery status only moves forward; scoped inbox. **No real WhatsApp Business, SMS or email provider is integrated** |
| Segments | Real | Declarative filters only (unknown keys rejected), no raw SQL |
| Broadcasts | Real | Audience snapshotted at prepare time with a recorded reason for everyone skipped; consent re-checked at send time; per-minute throttle; multi-worker safe (FOR UPDATE SKIP LOCKED claims, stale-claim recovery, idempotent per recipient); pause/resume/cancel with reason; retry transient failures, give up on permanent ones; attribution funnel campaign -> replies -> leads -> viewings -> deals |
| Workflow engine | Real | React Flow editor (UI only). Server-side static analysis before publish: schema per node (strict), single trigger, reachability, required branches, cycles, mandatory timeout on event waits, template/consent-purpose/entitlement/permission checks. Versions immutable. Waits are database rows (time and event with timeout branch) resumed by the scheduler/worker. Runs are once per (version, event). Workflows act with a least-privilege identity through the same domain services (consent gate, state machines, audit). Chain depth capped, step cap, disabling cancels in-flight runs |
| Plumbing | Real | Worker feeds every outbox event to workflows; messaging webhook (signed) -> dedupe -> persist -> worker; scheduler ticks campaigns and due waits per tenant |
| API + UI | Real | 27 more route files; pages for inbox/conversation, templates, campaigns/detail, automation list and the React Flow editor |

### Deferred from Phase 4 (tracked)
- Real WhatsApp Business / SMS / email providers (webhook signature schemes, template sync with Meta), email deliverability (SPF/DKIM, bounce handling, unsubscribe headers).
- Segment builder UI, campaign creation UI, template version diff/preview UI, workflow node palette for AI/HTTP/ERP nodes, subworkflows.
- Bot builder and runtime (phase 7), unified inbox assignment/transfer, canned replies, internal notes.
- Temporal runtime behind `WorkflowRuntime` (the MySQL-persisted runtime is the first implementation).

## Phase 5 - Property management: DONE (domain, API and read-only UI; write UI via API)

| Area | Status | Notes |
|---|---|---|
| Portfolios, ownership, management agreements | Real | Co-ownership shares capped at 100% under a unit row lock; one active agreement per portfolio |
| Leases (parties, term, rent schedule, addenda) | Real | Whole-month terms; unit row lock plus inclusive date-range overlap check, so no contradictory occupancy even under concurrency. Leases do not change `units.status` |
| Rent schedule | Real | Generated with exact fils allocation: instalments always sum to the contract total (annual x months / 12) |
| Activation gate | Real | Driven by the versioned `lease.activation` regulatory rule (registration ref, SIGNED contract via a completed envelope, optional deposit). Rule values are ILLUSTRATIVE and need review by a UAE tenancy specialist |
| Rent payments | Real | Reuses finance `createSucceededPaymentInUow`; allocated oldest-first under row locks; overpayment refused |
| Security deposits | Real | Append-only movements; deduction needs reason + step-up and cannot exceed the balance; refund only after the lease ends |
| Renewal / termination | Real | Renewal creates a linked draft with the same parties; optional tenant-setting cap (`lease.max_renewal_increase_pct`) with manager override + reason. The platform makes no legal claim about permitted increases. Termination cancels future instalments |
| Sweeps | Real | Daily idempotent: end finished leases, flag overdue rent once, 90/60/30-day expiry notices once each (`lease_milestones`); wired into `runSweeps` |
| Maintenance | Real | Tickets, vendors, quotations, approval (threshold setting `maintenance.approval_threshold`), work orders, append-only events, SLA hours by priority (4/24/72/168), SLA breach sweep, SLA report |
| Inspections | Real | Templates, scheduled/in-progress/completed/signed, per-item version, offline sync with client mutation ids (replays no-op) and conflict reporting instead of overwrite |
| Owner statements | Real | Rent collected - management fee - maintenance cost per portfolio and month; draft recomputed, frozen when issued |
| API | Real | 40+ routes under `/api/v1` (portfolios, ownerships, leases, maintenance-tickets, vendors, inspections, statements) |
| UI | Partial | Read-only pages for portfolios/statements, leases (+detail), maintenance. Write actions are API-only for now |
| Tests | Real | `tests/leases.test.ts` (14): schedule maths, overlap + concurrency, activation gate, rent allocation under concurrency, deposits, renewal cap, sweeps, tenant isolation, maintenance flow, SLA, offline sync conflicts |

### Deferred from Phase 5 (tracked)
- Write forms for leases/tickets/inspections in the web UI; the mobile inspector app itself (Phase 8) - only the sync API exists.
- Automatic Ejari/Tawtheeq submission (manual reference entry only).
- Surplus-rent credit handling, late fees, utilities billing, vendor payments/invoice matching.
- Owner statement PDF/e-mail delivery and payout execution.

## Phase 6 - Compliance: NOT STARTED
## Phase 7 - Intelligence and analytics: NOT STARTED
## Phase 8 - Enterprise hardening: NOT STARTED
