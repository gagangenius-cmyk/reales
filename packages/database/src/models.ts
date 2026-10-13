import { DataTypes as T, Model, ModelStatic, Sequelize } from "sequelize";

/**
 * Loosely-typed models for the foundation tables. Tenant-owned tables are registered in
 * TENANT_OWNED_TABLES so isolation tests can verify that every tenant_id table is covered.
 */
type M = ModelStatic<Model<any, any>>;

const pk = () => ({ type: T.UUID, primaryKey: true, defaultValue: T.UUIDV4 });
const tid = () => ({ type: T.UUID, allowNull: false });
const uuid = () => ({ type: T.UUID, allowNull: true });
const s = (n: number, allowNull = true) => ({ type: T.STRING(n), allowNull });

/** Tables that carry tenant_id. Tenant-aware repositories are the only sanctioned access path. */
export const TENANT_OWNED_TABLES = [
  "tenant_settings", "subscriptions", "tenant_entitlements", "tenant_quotas", "usage_meters",
  "users", "user_profiles", "sessions", "mfa_methods", "login_events", "security_events",
  "roles", "role_permissions", "user_roles", "business_units", "branches", "teams", "team_members",
  "projects", "audit_events", "outbox_events", "idempotency_keys",
  // phase 2
  "organizations", "contacts", "consent_purposes", "consent_records", "consent_events", "suppression_entries",
  "lead_sources", "pipelines", "pipeline_stages", "routing_rules", "leads", "lead_stage_events", "lead_assignments",
  "activities", "tasks", "developers", "real_estate_projects", "buildings", "units",
  "broker_licences", "listings", "listing_media", "listing_prices", "listing_permits",
  "portal_accounts", "portal_publications", "portal_sync_logs",
  // phase 3
  "viewings", "viewing_feedback", "offers", "offer_revisions", "reservations", "deals", "deal_stage_events", "deal_parties", "deal_milestones",
  "documents", "document_versions", "document_links", "signature_envelopes", "signature_signers", "signature_events",
  "counters", "invoices", "invoice_lines", "payments", "payment_allocations", "receipts", "webhook_events",
  "commission_plans", "commission_calculations", "commission_splits",
  // phase 4
  "channel_accounts", "conversations", "messages", "message_events", "templates", "template_versions",
  "segments", "campaigns", "campaign_recipients", "campaign_events",
  "workflows", "workflow_versions", "workflow_runs", "workflow_steps", "workflow_waits",
] as const;

/** Tables intentionally NOT tenant-owned (global catalogues / tenant root). */
export const GLOBAL_TABLES = [
  "tenants", "plans", "features", "plan_features", "permissions", "schema_migrations",
  "jurisdictions", "regulatory_rules", "regulatory_rule_versions",
] as const;

export interface Models {
  Tenant: M; TenantSetting: M; Plan: M; Feature: M; Subscription: M; TenantEntitlement: M; TenantQuota: M; UsageMeter: M;
  User: M; UserProfile: M; Session: M; MfaMethod: M; LoginEvent: M; SecurityEvent: M;
  Permission: M; Role: M; RolePermission: M; UserRole: M;
  BusinessUnit: M; Branch: M; Team: M; TeamMember: M; Project: M;
  AuditEvent: M; OutboxEvent: M; IdempotencyKey: M;
  Organization: M; Contact: M; ConsentPurpose: M; ConsentRecord: M; ConsentEvent: M; SuppressionEntry: M;
  LeadSource: M; Pipeline: M; PipelineStage: M; RoutingRule: M; Lead: M; LeadStageEvent: M; LeadAssignment: M;
  Activity: M; Task: M; Developer: M; ReProject: M; Building: M; Unit: M;
  BrokerLicence: M; Listing: M; ListingMedia: M; ListingPrice: M; ListingPermit: M;
  PortalAccount: M; PortalPublication: M; PortalSyncLog: M;
  Jurisdiction: M; RegulatoryRule: M; RegulatoryRuleVersion: M;
  Viewing: M; ViewingFeedback: M; Offer: M; OfferRevision: M; Reservation: M; Deal: M; DealStageEvent: M; DealParty: M; DealMilestone: M;
  Document: M; DocumentVersion: M; DocumentLink: M; SignatureEnvelope: M; SignatureSigner: M; SignatureEvent: M;
  Counter: M; Invoice: M; InvoiceLine: M; Payment: M; PaymentAllocation: M; Receipt: M; WebhookEvent: M;
  CommissionPlan: M; CommissionCalculation: M; CommissionSplit: M;
  ChannelAccount: M; Conversation: M; Message: M; MessageEvent: M; Template: M; TemplateVersion: M;
  Segment: M; Campaign: M; CampaignRecipient: M; CampaignEvent: M;
  Workflow: M; WorkflowVersion: M; WorkflowRun: M; WorkflowStep: M; WorkflowWait: M;
}

const cache = new WeakMap<Sequelize, Models>();

export function initModels(sq: Sequelize): Models {
  const hit = cache.get(sq);
  if (hit) return hit;
  const d = (name: string, table: string, attrs: Record<string, any>, opts: Record<string, any> = {}): M =>
    sq.define(name, attrs, { tableName: table, underscored: true, ...opts }) as M;
  const noTs = { timestamps: false };
  const createdOnly = { timestamps: true, updatedAt: false };

  const m = {
    Tenant: d("Tenant", "tenants", {
      id: pk(), name: s(180, false), slug: s(100, false), status: T.ENUM("active", "suspended"),
      dataRegion: s(32, false), jurisdiction: s(40, false), country: s(2, false),
    }),
    TenantSetting: d("TenantSetting", "tenant_settings", { id: pk(), tenantId: tid(), key: s(120, false), value: T.JSON }),
    Plan: d("Plan", "plans", { id: pk(), code: s(40, false), name: s(120, false), limits: T.JSON }),
    Feature: d("Feature", "features", { id: pk(), code: s(60, false), description: s(255) }),
    Subscription: d("Subscription", "subscriptions", {
      id: pk(), tenantId: tid(), planId: tid(), status: T.ENUM("trialing", "active", "past_due", "cancelled"),
      startsAt: { type: T.DATE(3), allowNull: false }, endsAt: T.DATE(3),
    }),
    TenantEntitlement: d("TenantEntitlement", "tenant_entitlements", { id: pk(), tenantId: tid(), featureCode: s(60, false), enabled: T.BOOLEAN }),
    TenantQuota: d("TenantQuota", "tenant_quotas", { id: pk(), tenantId: tid(), quotaKey: s(60, false), limitValue: T.BIGINT }),
    UsageMeter: d("UsageMeter", "usage_meters", { id: pk(), tenantId: tid(), meterKey: s(60, false), period: s(10, false), value: T.BIGINT }),

    User: d("User", "users", {
      id: pk(), tenantId: tid(), email: s(254, false), normalizedEmail: s(254, false), passwordHash: s(255),
      status: T.ENUM("active", "invited", "disabled"), businessUnitId: uuid(), branchId: uuid(),
      failedLoginCount: T.INTEGER, lockedUntil: T.DATE(3), lastLoginAt: T.DATE(3),
    }),
    UserProfile: d("UserProfile", "user_profiles", {
      userId: { type: T.UUID, primaryKey: true }, tenantId: tid(), firstName: s(120), lastName: s(120),
      phoneE164: s(32), locale: s(10, false), timezone: s(64, false),
    }),
    Session: d("Session", "sessions", {
      id: pk(), tenantId: tid(), userId: tid(), secretHash: s(64, false), userAgent: s(255), ip: s(64),
      expiresAt: { type: T.DATE(3), allowNull: false }, lastSeenAt: { type: T.DATE(3), allowNull: false },
      revokedAt: T.DATE(3), mfaVerifiedAt: T.DATE(3), stepUpUntil: T.DATE(3),
    }),
    MfaMethod: d("MfaMethod", "mfa_methods", {
      id: pk(), tenantId: tid(), userId: tid(), type: T.ENUM("totp"), secretEncrypted: { type: T.TEXT, allowNull: false },
      verifiedAt: T.DATE(3), lastUsedStep: T.BIGINT, recoveryCodesHash: T.JSON,
    }),
    LoginEvent: d("LoginEvent", "login_events", {
      id: pk(), tenantId: uuid(), userId: uuid(), email: s(254),
      outcome: T.ENUM("success", "bad_password", "unknown_user", "locked", "mfa_required", "mfa_failed", "disabled"),
      ip: s(64), userAgent: s(255),
    }, createdOnly),
    SecurityEvent: d("SecurityEvent", "security_events", { id: pk(), tenantId: tid(), userId: uuid(), type: s(60, false), details: T.JSON }, createdOnly),

    Permission: d("Permission", "permissions", { id: pk(), key: s(100, false), description: s(255) }),
    Role: d("Role", "roles", { id: pk(), tenantId: tid(), key: s(60, false), name: s(120, false), isSystem: T.BOOLEAN, requiresMfa: T.BOOLEAN }),
    RolePermission: d("RolePermission", "role_permissions", {
      id: pk(), tenantId: tid(), roleId: tid(), permissionId: tid(),
      scope: T.ENUM("tenant", "business_unit", "branch", "project", "portfolio", "own_records"),
    }),
    UserRole: d("UserRole", "user_roles", {
      id: pk(), tenantId: tid(), userId: tid(), roleId: tid(),
      anchorType: T.ENUM("business_unit", "branch", "project", "portfolio"), anchorId: uuid(),
    }),

    BusinessUnit: d("BusinessUnit", "business_units", { id: pk(), tenantId: tid(), name: s(180, false), type: T.ENUM("brokerage", "property_management", "developer") }),
    Branch: d("Branch", "branches", { id: pk(), tenantId: tid(), businessUnitId: tid(), name: s(180, false), city: s(80) }),
    Team: d("Team", "teams", { id: pk(), tenantId: tid(), branchId: uuid(), name: s(180, false) }),
    TeamMember: d("TeamMember", "team_members", { id: pk(), tenantId: tid(), teamId: tid(), userId: tid() }),
    Project: d("Project", "projects", {
      id: pk(), tenantId: tid(), businessUnitId: uuid(), kind: T.ENUM("project", "portfolio", "workspace"),
      code: s(40, false), name: s(180, false), status: T.ENUM("active", "archived"),
    }),

    AuditEvent: d("AuditEvent", "audit_events", {
      id: pk(), tenantId: tid(), seq: { type: T.BIGINT, allowNull: false }, actorId: s(64), action: s(100, false),
      entityType: s(60), entityId: s(64), before: T.JSON, after: T.JSON, reason: s(500), correlationId: s(80, false), ip: s(64),
      prevHash: s(64), hash: s(64, false), createdAt: { type: T.DATE(3), allowNull: false },
    }, { ...noTs }),
    OutboxEvent: d("OutboxEvent", "outbox_events", {
      id: pk(), tenantId: tid(), type: s(100, false), version: T.INTEGER, projectId: uuid(), aggregateType: s(60, false), aggregateId: s(64, false),
      actorId: s(64), correlationId: s(80, false), causationId: s(80), payload: { type: T.JSON, allowNull: false },
      occurredAt: { type: T.DATE(3), allowNull: false }, status: T.ENUM("pending", "dispatched", "failed"), attempts: T.INTEGER,
      nextAttemptAt: { type: T.DATE(3), allowNull: false }, dispatchedAt: T.DATE(3), lastError: T.TEXT,
    }, { ...noTs }),
    IdempotencyKey: d("IdempotencyKey", "idempotency_keys", {
      id: pk(), tenantId: tid(), scope: s(120, false), key: s(200, false), requestHash: s(64, false),
      status: T.ENUM("in_progress", "completed"), responseStatus: T.INTEGER, responseBody: T.JSON,
      expiresAt: { type: T.DATE(3), allowNull: false },
    }, createdOnly),
  } as unknown as Models;
  // A fresh object per attribute: Sequelize mutates attribute definitions in place (field/fieldName), so sharing one breaks columns.
  const dt3 = () => ({ type: T.DATE(3), allowNull: false });
  const money = (allowNull = true) => ({ type: T.DECIMAL(18, 2), allowNull });
  const noTs2 = { timestamps: false };
  Object.assign(m, {
    Organization: d("Organization", "organizations", { id: pk(), tenantId: tid(), name: s(180, false), tradeLicenceNo: s(80), licenceAuthority: s(80), country: s(2, false) }),
    Contact: d("Contact", "contacts", {
      id: pk(), tenantId: tid(), type: T.ENUM("person", "company"), firstName: s(120), lastName: s(120), companyName: s(180),
      email: s(254), normalizedEmail: s(254), phoneE164: s(32), language: s(10), nationality: s(60),
      organizationId: uuid(), ownerUserId: uuid(), branchId: uuid(), status: T.ENUM("active", "archived"),
    }),
    ConsentPurpose: d("ConsentPurpose", "consent_purposes", { id: pk(), tenantId: tid(), code: s(60, false), name: s(120, false), description: s(500), defaultBasis: T.ENUM("consent", "contract", "legitimate_interest", "legal_obligation") }),
    ConsentRecord: d("ConsentRecord", "consent_records", {
      id: pk(), tenantId: tid(), contactId: tid(), purposeId: tid(), channel: T.ENUM("whatsapp", "sms", "email", "call"),
      status: T.ENUM("granted", "revoked"), basis: s(40, false), textVersion: s(60), source: s(80), grantedAt: T.DATE(3), revokedAt: T.DATE(3),
    }),
    ConsentEvent: d("ConsentEvent", "consent_events", {
      id: pk(), tenantId: tid(), consentRecordId: tid(), contactId: tid(), purposeId: tid(), channel: T.ENUM("whatsapp", "sms", "email", "call"),
      event: T.ENUM("granted", "revoked"), basis: s(40, false), textVersion: s(60), textHash: s(64), source: s(80), ip: s(64), userAgent: s(255), actorId: s(64),
      createdAt: dt3(),
    }, noTs2),
    SuppressionEntry: d("SuppressionEntry", "suppression_entries", {
      id: pk(), tenantId: tid(), channel: T.ENUM("whatsapp", "sms", "email", "call"), destination: s(254, false),
      reason: T.ENUM("unsubscribed", "complaint", "dnd", "bounced", "manual", "legal"), contactId: uuid(), createdBy: s(64),
    }),
    LeadSource: d("LeadSource", "lead_sources", { id: pk(), tenantId: tid(), code: s(60, false), name: s(120, false), kind: T.ENUM("portal", "campaign", "walk_in", "referral", "api", "call", "form", "other") }),
    Pipeline: d("Pipeline", "pipelines", { id: pk(), tenantId: tid(), name: s(120, false), isDefault: T.BOOLEAN, projectId: uuid() }),
    PipelineStage: d("PipelineStage", "pipeline_stages", { id: pk(), tenantId: tid(), pipelineId: tid(), key: s(40, false), name: s(80, false), position: T.INTEGER, kind: T.ENUM("open", "won", "lost"), slaMinutes: T.INTEGER }),
    RoutingRule: d("RoutingRule", "routing_rules", {
      id: pk(), tenantId: tid(), name: s(120, false), priority: T.INTEGER, active: T.BOOLEAN, conditions: { type: T.JSON, allowNull: false },
      target: { type: T.JSON, allowNull: false }, strategy: T.ENUM("round_robin", "least_loaded"), maxOpenLeads: T.INTEGER,
    }),
    Lead: d("Lead", "leads", {
      id: pk(), tenantId: tid(), contactId: tid(), projectId: uuid(), sourceId: uuid(), pipelineId: tid(), stageId: tid(),
      status: T.ENUM("open", "won", "lost"), purpose: T.ENUM("buy", "rent", "invest", "off_plan"), budgetMin: money(), budgetMax: money(),
      currency: s(3, false), preferredAreas: T.JSON, bedrooms: T.INTEGER, language: s(10), assignedUserId: uuid(), branchId: uuid(),
      score: T.DECIMAL(6, 3), lostReason: s(255), firstResponseAt: T.DATE(3),
    }),
    LeadStageEvent: d("LeadStageEvent", "lead_stage_events", { id: pk(), tenantId: tid(), leadId: tid(), fromStageId: uuid(), toStageId: tid(), actorId: s(64), reason: s(255), createdAt: dt3() }, noTs2),
    LeadAssignment: d("LeadAssignment", "lead_assignments", {
      id: pk(), tenantId: tid(), leadId: tid(), assignedUserId: uuid(), previousUserId: uuid(), ruleId: uuid(),
      method: T.ENUM("rule", "manual", "fallback"), reason: s(255), actorId: s(64), createdAt: dt3(),
    }, noTs2),
    Activity: d("Activity", "activities", {
      id: pk(), tenantId: tid(), entityType: s(40, false), entityId: tid(), kind: T.ENUM("note", "call", "whatsapp", "email", "sms", "viewing", "system"),
      summary: { type: T.TEXT, allowNull: false }, actorId: s(64), occurredAt: dt3(), createdAt: dt3(),
    }, noTs2),
    Task: d("Task", "tasks", { id: pk(), tenantId: tid(), title: s(255, false), leadId: uuid(), assigneeId: uuid(), dueAt: T.DATE(3), status: T.ENUM("open", "done", "cancelled"), completedAt: T.DATE(3) }),
    Developer: d("Developer", "developers", { id: pk(), tenantId: tid(), name: s(180, false), registrationNo: s(80), jurisdictionCode: s(40, false), escrowRegistered: T.BOOLEAN }),
    ReProject: d("ReProject", "real_estate_projects", {
      id: pk(), tenantId: tid(), developerId: uuid(), crmProjectId: uuid(), name: s(180, false), jurisdictionCode: s(40, false), kind: T.ENUM("ready", "off_plan"),
      registrationNo: s(80), escrowAccountRef: s(120), handoverDate: T.DATEONLY, status: T.ENUM("planning", "selling", "completed", "archived"),
    }),
    Building: d("Building", "buildings", { id: pk(), tenantId: tid(), reProjectId: tid(), name: s(180, false), community: s(120), city: s(80), floorsCount: T.INTEGER }),
    Unit: d("Unit", "units", {
      id: pk(), tenantId: tid(), buildingId: tid(), unitNumber: s(40, false), floor: T.INTEGER,
      type: T.ENUM("apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"), bedrooms: T.INTEGER, bathrooms: T.INTEGER,
      areaSqft: T.DECIMAL(12, 2), view: s(80), status: T.ENUM("available", "reserved", "sold", "rented", "blocked"), listPrice: money(), currency: s(3, false), ownerContactId: uuid(),
    }),
    BrokerLicence: d("BrokerLicence", "broker_licences", {
      id: pk(), tenantId: tid(), holderType: T.ENUM("company", "agent"), holderName: s(180, false), userId: uuid(), licenceNo: s(80, false), authority: s(60, false),
      issuedAt: T.DATEONLY, expiresAt: { type: T.DATEONLY, allowNull: false }, validationStatus: T.ENUM("unverified", "valid", "revoked"), verifiedAt: T.DATE(3), verifiedBy: s(64),
    }),
    Listing: d("Listing", "listings", {
      id: pk(), tenantId: tid(), unitId: tid(), purpose: T.ENUM("sale", "rent"), status: T.ENUM("draft", "published", "unpublished"), title: s(255),
      description: T.TEXT, price: money(), currency: s(3, false), agentUserId: uuid(), branchId: uuid(), projectId: uuid(), jurisdictionCode: s(40, false),
      brokerLicenceId: uuid(), publishedAt: T.DATE(3),
    }),
    ListingMedia: d("ListingMedia", "listing_media", { id: pk(), tenantId: tid(), listingId: tid(), kind: T.ENUM("image", "video", "floorplan"), storageKey: s(500, false), position: T.INTEGER }),
    ListingPrice: d("ListingPrice", "listing_prices", { id: pk(), tenantId: tid(), listingId: tid(), price: money(false), currency: s(3, false), changedBy: s(64), createdAt: dt3() }, noTs2),
    ListingPermit: d("ListingPermit", "listing_permits", {
      id: pk(), tenantId: tid(), listingId: tid(), permitNo: s(80, false), authority: s(60, false), issuedAt: T.DATEONLY, expiresAt: { type: T.DATEONLY, allowNull: false },
      status: T.ENUM("pending", "valid", "revoked", "rejected"), source: T.ENUM("manual", "api"), verifiedAt: T.DATE(3), verifiedBy: s(64),
    }),
    PortalAccount: d("PortalAccount", "portal_accounts", { id: pk(), tenantId: tid(), provider: s(40, false), name: s(120, false), mode: T.ENUM("export", "api"), config: T.JSON, status: T.ENUM("active", "disabled") }),
    PortalPublication: d("PortalPublication", "portal_publications", {
      id: pk(), tenantId: tid(), listingId: tid(), portalAccountId: tid(), action: T.ENUM("publish", "update", "unpublish"), status: T.ENUM("exported", "sent", "failed"),
      snapshot: { type: T.JSON, allowNull: false }, snapshotHash: s(64, false), payloadFormat: s(20), payload: T.TEXT("medium"), externalRef: s(120), error: T.TEXT, actorId: s(64), createdAt: dt3(),
    }, noTs2),
    PortalSyncLog: d("PortalSyncLog", "portal_sync_logs", { id: pk(), tenantId: tid(), portalAccountId: tid(), listingId: uuid(), action: s(40, false), outcome: s(20, false), detail: s(500), createdAt: dt3() }, noTs2),
    Jurisdiction: d("Jurisdiction", "jurisdictions", { id: pk(), code: s(40, false), name: s(120, false), emirate: s(40, false), registrationAuthority: s(60, false), tenancyAuthority: s(60) }),
    RegulatoryRule: d("RegulatoryRule", "regulatory_rules", { id: pk(), jurisdictionId: tid(), code: s(80, false), description: s(500) }),
    RegulatoryRuleVersion: d("RegulatoryRuleVersion", "regulatory_rule_versions", { id: pk(), ruleId: tid(), version: T.INTEGER, effectiveFrom: { type: T.DATEONLY, allowNull: false }, effectiveTo: T.DATEONLY, definition: { type: T.JSON, allowNull: false } }),
  });
  Object.assign(m, {
    Viewing: d("Viewing", "viewings", {
      id: pk(), tenantId: tid(), leadId: uuid(), contactId: tid(), unitId: uuid(), listingId: uuid(), agentUserId: tid(), branchId: uuid(), projectId: uuid(),
      scheduledAt: dt3(), durationMin: T.INTEGER, status: T.ENUM("scheduled", "checked_in", "completed", "cancelled", "no_show"),
      locationNote: s(255), checkedInAt: T.DATE(3), completedAt: T.DATE(3), cancelledReason: s(255), createdBy: s(64),
    }),
    ViewingFeedback: d("ViewingFeedback", "viewing_feedback", {
      id: pk(), tenantId: tid(), viewingId: tid(), rating: T.INTEGER, interest: T.ENUM("high", "medium", "low", "none"), notes: T.TEXT, createdBy: s(64), createdAt: dt3(),
    }, noTs2),
    Offer: d("Offer", "offers", {
      id: pk(), tenantId: tid(), leadId: uuid(), contactId: tid(), unitId: tid(), listingId: uuid(), agentUserId: tid(), branchId: uuid(), projectId: uuid(),
      status: T.ENUM("draft", "submitted", "countered", "accepted", "rejected", "withdrawn", "expired"), currentAmount: money(false), currency: s(3, false),
      depositAmount: money(), validUntil: T.DATE(3), createdBy: s(64),
    }),
    OfferRevision: d("OfferRevision", "offer_revisions", {
      id: pk(), tenantId: tid(), offerId: tid(), revision: T.INTEGER, amount: money(false), terms: T.JSON, byParty: T.ENUM("buyer", "seller"), createdBy: s(64), createdAt: dt3(),
    }, noTs2),
    Reservation: d("Reservation", "reservations", {
      id: pk(), tenantId: tid(), unitId: tid(), contactId: tid(), offerId: uuid(), dealId: uuid(), status: T.ENUM("active", "converted", "cancelled", "expired"),
      expiresAt: dt3(), depositAmount: money(), currency: s(3, false), createdBy: s(64),
    }),
    Deal: d("Deal", "deals", {
      id: pk(), tenantId: tid(), dealType: T.ENUM("sale", "lease"), leadId: uuid(), unitId: tid(), contactId: tid(), offerId: uuid(), reservationId: uuid(),
      agentUserId: tid(), branchId: uuid(), projectId: uuid(), stage: T.ENUM("reserved", "contract", "signed", "payment", "registration", "closed", "cancelled"),
      status: T.ENUM("open", "closed", "cancelled"), amount: money(false), currency: s(3, false), cancelledReason: s(255), closedAt: T.DATE(3), createdBy: s(64),
    }),
    DealStageEvent: d("DealStageEvent", "deal_stage_events", { id: pk(), tenantId: tid(), dealId: tid(), fromStage: s(20), toStage: s(20, false), actorId: s(64), reason: s(255), createdAt: dt3() }, noTs2),
    DealParty: d("DealParty", "deal_parties", { id: pk(), tenantId: tid(), dealId: tid(), contactId: tid(), role: T.ENUM("buyer", "seller", "tenant", "landlord", "introducer"), sharePct: T.DECIMAL(5, 2) }),
    DealMilestone: d("DealMilestone", "deal_milestones", {
      id: pk(), tenantId: tid(), dealId: tid(), key: s(60, false), title: s(180, false), sortOrder: T.INTEGER, dueDate: T.DATEONLY, amount: money(),
      status: T.ENUM("pending", "done", "waived"), completedAt: T.DATE(3), completedBy: s(64),
    }),
    Document: d("Document", "documents", { id: pk(), tenantId: tid(), title: s(255, false), kind: T.ENUM("contract", "id_document", "permit", "invoice", "receipt", "other"), currentVersion: T.INTEGER, createdBy: s(64) }),
    DocumentVersion: d("DocumentVersion", "document_versions", {
      id: pk(), tenantId: tid(), documentId: tid(), version: T.INTEGER, storageKey: s(500, false), filename: s(255, false), mime: s(100, false), sizeBytes: T.BIGINT, contentHash: s(64, false), createdBy: s(64), createdAt: dt3(),
    }, noTs2),
    DocumentLink: d("DocumentLink", "document_links", { id: pk(), tenantId: tid(), documentId: tid(), entityType: s(40, false), entityId: tid(), createdAt: dt3() }, noTs2),
    SignatureEnvelope: d("SignatureEnvelope", "signature_envelopes", {
      id: pk(), tenantId: tid(), documentId: tid(), documentVersion: T.INTEGER, contentHash: s(64, false), provider: s(40, false), providerEnvelopeId: s(120), dealId: uuid(),
      status: T.ENUM("draft", "sent", "completed", "declined", "cancelled", "expired"), sentAt: T.DATE(3), completedAt: T.DATE(3), evidence: T.JSON, createdBy: s(64),
    }),
    SignatureSigner: d("SignatureSigner", "signature_signers", {
      id: pk(), tenantId: tid(), envelopeId: tid(), contactId: uuid(), name: s(180, false), email: s(254, false), signOrder: T.INTEGER,
      status: T.ENUM("pending", "viewed", "signed", "declined"), signedAt: T.DATE(3), signerIp: s(64), certificate: T.JSON,
    }),
    SignatureEvent: d("SignatureEvent", "signature_events", { id: pk(), tenantId: tid(), envelopeId: tid(), type: s(60, false), payload: T.JSON, createdAt: dt3() }, noTs2),
    Counter: d("Counter", "counters", { tenantId: { type: T.UUID, allowNull: false, primaryKey: true }, counterKey: { type: T.STRING(40), allowNull: false, primaryKey: true }, value: T.BIGINT }, noTs2),
    Invoice: d("Invoice", "invoices", {
      id: pk(), tenantId: tid(), number: s(40, false), dealId: uuid(), contactId: tid(), branchId: uuid(), status: T.ENUM("draft", "issued", "partially_paid", "paid", "void"),
      currency: s(3, false), subtotal: money(false), vatAmount: money(false), total: money(false), dueDate: T.DATEONLY, issuedAt: T.DATE(3), voidedAt: T.DATE(3), voidReason: s(255), createdBy: s(64),
    }),
    InvoiceLine: d("InvoiceLine", "invoice_lines", {
      id: pk(), tenantId: tid(), invoiceId: tid(), description: s(255, false), quantity: T.DECIMAL(12, 3), unitPrice: money(false), vatRate: T.DECIMAL(5, 2), amount: money(false), vatAmount: money(false), sortOrder: T.INTEGER,
    }, noTs2),
    Payment: d("Payment", "payments", {
      id: pk(), tenantId: tid(), contactId: tid(), dealId: uuid(), milestoneId: uuid(), invoiceId: uuid(), amount: money(false), currency: s(3, false), method: T.ENUM("card", "bank_transfer", "cheque", "cash"),
      provider: s(40, false), providerRef: s(120), status: T.ENUM("pending", "succeeded", "failed"), receivedAt: T.DATE(3), failureReason: s(255), createdBy: s(64),
    }),
    PaymentAllocation: d("PaymentAllocation", "payment_allocations", { id: pk(), tenantId: tid(), paymentId: tid(), invoiceId: tid(), amount: money(false), createdAt: dt3() }, noTs2),
    Receipt: d("Receipt", "receipts", { id: pk(), tenantId: tid(), paymentId: tid(), number: s(40, false), issuedAt: dt3() }, noTs2),
    WebhookEvent: d("WebhookEvent", "webhook_events", {
      id: pk(), tenantId: uuid(), provider: s(40, false), kind: s(20, false), eventId: s(160, false), rawBody: { type: T.TEXT("medium"), allowNull: false }, signatureValid: T.BOOLEAN,
      status: T.ENUM("received", "processed", "failed", "ignored"), error: T.TEXT, receivedAt: dt3(), processedAt: T.DATE(3),
    }, noTs2),
    CommissionPlan: d("CommissionPlan", "commission_plans", { id: pk(), tenantId: tid(), name: s(120, false), dealType: T.ENUM("sale", "lease"), ratePct: T.DECIMAL(6, 3), splits: { type: T.JSON, allowNull: false }, active: T.BOOLEAN }),
    CommissionCalculation: d("CommissionCalculation", "commission_calculations", {
      id: pk(), tenantId: tid(), dealId: tid(), planId: tid(), agentUserId: uuid(), branchId: uuid(), grossAmount: money(false), commissionAmount: money(false), currency: s(3, false),
      status: T.ENUM("calculated", "approved", "void"), approvedBy: s(64), approvedAt: T.DATE(3), calculatedAt: dt3(),
    }),
    CommissionSplit: d("CommissionSplit", "commission_splits", { id: pk(), tenantId: tid(), calculationId: tid(), role: s(40, false), userId: uuid(), pct: T.DECIMAL(6, 3), amount: money(false) }),
  });
  const CH = () => T.ENUM("email", "whatsapp", "sms");
  Object.assign(m, {
    ChannelAccount: d("ChannelAccount", "channel_accounts", { id: pk(), tenantId: tid(), channel: CH(), provider: s(40, false), name: s(120, false), identity: s(254, false), config: T.JSON, status: T.ENUM("active", "disabled") }),
    Conversation: d("Conversation", "conversations", {
      id: pk(), tenantId: tid(), contactId: tid(), channel: CH(), channelAccountId: uuid(), leadId: uuid(), assignedUserId: uuid(), branchId: uuid(),
      status: T.ENUM("open", "closed"), lastMessageAt: T.DATE(3), lastInboundAt: T.DATE(3), unreadCount: T.INTEGER,
    }),
    Message: d("Message", "messages", {
      id: pk(), tenantId: tid(), conversationId: tid(), direction: T.ENUM("inbound", "outbound"), channel: CH(),
      status: T.ENUM("queued", "sent", "delivered", "read", "failed", "received"), body: { type: T.TEXT, allowNull: false }, subject: s(255),
      templateVersionId: uuid(), campaignId: uuid(), workflowRunId: uuid(), provider: s(40), providerMessageId: s(160), idempotencyKey: s(200), error: s(500),
      senderUserId: uuid(), occurredAt: dt3(),
    }),
    MessageEvent: d("MessageEvent", "message_events", { id: pk(), tenantId: tid(), messageId: tid(), type: s(30, false), providerEventId: s(160), payload: T.JSON, createdAt: dt3() }, noTs2),
    Template: d("Template", "templates", { id: pk(), tenantId: tid(), projectId: uuid(), channel: CH(), name: s(160, false), purpose: s(60), status: T.ENUM("draft", "approved", "archived"), currentVersionId: uuid(), createdBy: s(64) }),
    TemplateVersion: d("TemplateVersion", "template_versions", {
      id: pk(), tenantId: tid(), templateId: tid(), version: T.INTEGER, subject: s(255), designJson: T.JSON, renderedHtml: T.TEXT("medium"), textBody: T.TEXT,
      structuredComponentsJson: T.JSON, variableSchemaJson: T.JSON, approvalStatus: T.ENUM("not_required", "pending", "approved", "rejected"), createdBy: s(64), createdAt: dt3(),
    }, noTs2),
    Segment: d("Segment", "segments", { id: pk(), tenantId: tid(), name: s(160, false), definition: { type: T.JSON, allowNull: false }, createdBy: s(64) }),
    Campaign: d("Campaign", "campaigns", {
      id: pk(), tenantId: tid(), name: s(160, false), channel: CH(), templateVersionId: tid(), segmentId: uuid(), channelAccountId: tid(), purposeCode: s(60, false),
      status: T.ENUM("draft", "scheduled", "preparing", "running", "paused", "completed", "failed", "cancelled"), scheduledAt: T.DATE(3), startedAt: T.DATE(3), completedAt: T.DATE(3),
      maxPerMinute: T.INTEGER, totals: T.JSON, createdBy: s(64),
    }),
    CampaignRecipient: d("CampaignRecipient", "campaign_recipients", {
      id: pk(), tenantId: tid(), campaignId: tid(), contactId: tid(), destination: s(254, false), channel: CH(),
      status: T.ENUM("pending", "sending", "sent", "delivered", "read", "replied", "failed", "skipped"), skipReason: s(60), messageId: uuid(), attempts: T.INTEGER, lastError: s(500), sentAt: T.DATE(3),
    }),
    CampaignEvent: d("CampaignEvent", "campaign_events", { id: pk(), tenantId: tid(), campaignId: tid(), type: s(40, false), detail: T.JSON, createdAt: dt3() }, noTs2),
    Workflow: d("Workflow", "workflows", { id: pk(), tenantId: tid(), projectId: uuid(), name: s(160, false), status: T.ENUM("draft", "published", "disabled"), draftGraph: T.JSON, currentVersion: T.INTEGER, createdBy: s(64) }),
    WorkflowVersion: d("WorkflowVersion", "workflow_versions", { id: pk(), tenantId: tid(), workflowId: tid(), version: T.INTEGER, graph: { type: T.JSON, allowNull: false }, triggerType: s(80, false), publishedBy: s(64), createdAt: dt3() }, noTs2),
    WorkflowRun: d("WorkflowRun", "workflow_runs", {
      id: pk(), tenantId: tid(), workflowId: tid(), versionId: tid(), triggerEventId: s(64, false), entityType: s(40, false), entityId: tid(),
      status: T.ENUM("running", "waiting", "completed", "failed", "cancelled"), context: T.JSON, stepsExecuted: T.INTEGER, error: s(500), startedAt: dt3(), finishedAt: T.DATE(3),
    }),
    WorkflowStep: d("WorkflowStep", "workflow_steps", { id: pk(), tenantId: tid(), runId: tid(), nodeId: s(80, false), nodeType: s(80, false), status: T.ENUM("completed", "failed", "skipped"), output: T.JSON, error: s(500), createdAt: dt3() }, noTs2),
    WorkflowWait: d("WorkflowWait", "workflow_waits", {
      id: pk(), tenantId: tid(), runId: tid(), nodeId: s(80, false), kind: T.ENUM("until", "event"), resumeAt: T.DATE(3), eventType: s(80), matchEntityId: uuid(), timeoutAt: T.DATE(3),
      status: T.ENUM("waiting", "resumed", "timed_out", "cancelled"), resolvedBy: s(40), createdAt: dt3(),
    }, noTs2),
  });
  cache.set(sq, m);
  return m;
}
