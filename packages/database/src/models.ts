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
  // phase 5
  "portfolios", "ownerships", "management_agreements", "leases", "lease_parties", "lease_addenda", "rent_schedules", "rent_allocations",
  "security_deposits", "deposit_movements", "lease_milestones", "vendors", "maintenance_tickets", "quotations", "work_orders", "work_order_events",
  "inspection_templates", "inspections", "inspection_items", "inspection_media", "inspection_mutations", "owner_statements",
  // phase 6
  "kyc_profiles", "kyc_documents", "ubo_links", "screening_runs", "screening_hits", "compliance_cases", "case_events", "dsr_requests", "retention_policies", "legal_holds",
  // phase 7
  "scoring_models", "lead_scores", "bots", "bot_versions", "bot_sessions", "bot_session_events",
  // phase 8
  "sso_connections", "sso_states", "data_processing_policies", "subprocessors", "mobile_devices", "mobile_mutations",
  // crm extras
  "saved_searches", "property_matches", "notifications", "referral_partners", "referrals", "valuations",
  // onboarding and data import
  "auth_tokens", "import_jobs", "portal_links",
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
  CommissionPlan: M; CommissionCalculation: M; CommissionSplit: M; AgentProfile: M;
  ChannelAccount: M; Conversation: M; Message: M; MessageEvent: M; Template: M; TemplateVersion: M;
  Segment: M; Campaign: M; CampaignRecipient: M; CampaignEvent: M;
  Workflow: M; WorkflowVersion: M; WorkflowRun: M; WorkflowStep: M; WorkflowWait: M;
  Portfolio: M; Ownership: M; ManagementAgreement: M; Lease: M; LeaseParty: M; LeaseAddendum: M; RentSchedule: M; RentAllocation: M;
  SecurityDeposit: M; DepositMovement: M; LeaseMilestone: M; Vendor: M; Ticket: M; Quotation: M; WorkOrder: M; WorkOrderEvent: M;
  InspectionTemplate: M; Inspection: M; InspectionItem: M; InspectionMedia: M; InspectionMutation: M; OwnerStatement: M;
  KycProfile: M; KycDocument: M; UboLink: M; ScreeningRun: M; ScreeningHit: M; ComplianceCase: M; CaseEvent: M; DsrRequest: M; RetentionPolicy: M; LegalHold: M;
  ScoringModel: M; LeadScore: M; Bot: M; BotVersion: M; BotSession: M; BotSessionEvent: M;
  SsoConnection: M; SsoState: M; DataProcessingPolicy: M; Subprocessor: M; MobileDevice: M; MobileMutation: M;
  SavedSearch: M; PropertyMatch: M; Notification: M; ReferralPartner: M; Referral: M; Valuation: M;
  AuthToken: M; ImportJob: M; PortalLink: M;
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
      score: T.DECIMAL(6, 3), lostReason: s(255), firstResponseAt: T.DATE(3), isHot: T.BOOLEAN, campaign: s(160),
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
    CommissionPlan: d("CommissionPlan", "commission_plans", { id: pk(), tenantId: tid(), name: s(120, false), dealType: T.ENUM("sale", "lease"), ratePct: T.DECIMAL(6, 3), splits: { type: T.JSON, allowNull: false }, active: T.BOOLEAN, agentType: T.ENUM("any", "internal", "external"), vatPct: T.DECIMAL(5, 2) }),
    AgentProfile: d("AgentProfile", "agent_profiles", { id: pk(), tenantId: tid(), userId: tid(), agentType: T.ENUM("internal", "external"), commissionPlanId: uuid(), brn: s(40), agencyName: s(160), agencyLicenceNo: s(60), payoutNote: s(255), status: T.ENUM("active", "inactive") }),
    CommissionCalculation: d("CommissionCalculation", "commission_calculations", {
      id: pk(), tenantId: tid(), dealId: tid(), planId: tid(), agentUserId: uuid(), branchId: uuid(), grossAmount: money(false), commissionAmount: money(false), currency: s(3, false),
      status: T.ENUM("calculated", "approved", "void"), approvedBy: s(64), approvedAt: T.DATE(3), calculatedAt: dt3(),
      agentType: T.ENUM("internal", "external"), vatAmount: money(false), paidAt: T.DATE(3), paidBy: s(64), paidReference: s(120),
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
  const D = () => ({ type: T.DATEONLY, allowNull: false });
  const DN = () => ({ type: T.DATEONLY, allowNull: true });
  Object.assign(m, {
    Portfolio: d("Portfolio", "portfolios", { id: pk(), tenantId: tid(), name: s(180, false), ownerContactId: tid(), branchId: uuid(), status: T.ENUM("active", "closed") }),
    Ownership: d("Ownership", "ownerships", { id: pk(), tenantId: tid(), unitId: tid(), portfolioId: tid(), sharePct: T.DECIMAL(5, 2), fromDate: D(), toDate: DN() }),
    ManagementAgreement: d("ManagementAgreement", "management_agreements", { id: pk(), tenantId: tid(), portfolioId: tid(), feePct: T.DECIMAL(5, 2), startsOn: D(), endsOn: DN(), status: T.ENUM("active", "ended"), documentId: uuid() }),
    Lease: d("Lease", "leases", {
      id: pk(), tenantId: tid(), unitId: tid(), portfolioId: uuid(), branchId: uuid(), agentUserId: uuid(), previousLeaseId: uuid(), status: T.ENUM("draft", "active", "ended", "terminated"),
      startsOn: D(), endsOn: D(), annualRent: money(false), currency: s(3, false), installments: T.INTEGER, registrationRef: s(80), contractDocumentId: uuid(), jurisdictionCode: s(40, false),
      noticeGivenOn: DN(), terminatedOn: DN(), terminationReason: s(500), activatedAt: T.DATE(3), createdBy: s(64),
    }),
    LeaseParty: d("LeaseParty", "lease_parties", { id: pk(), tenantId: tid(), leaseId: tid(), contactId: tid(), role: T.ENUM("tenant", "landlord", "guarantor", "occupant") }),
    LeaseAddendum: d("LeaseAddendum", "lease_addenda", { id: pk(), tenantId: tid(), leaseId: tid(), title: s(255, false), effectiveOn: D(), changes: T.JSON, documentId: uuid(), createdBy: s(64), createdAt: dt3() }, noTs2),
    RentSchedule: d("RentSchedule", "rent_schedules", {
      id: pk(), tenantId: tid(), leaseId: tid(), seq: T.INTEGER, dueDate: D(), amount: money(false), paidAmount: money(false),
      status: T.ENUM("pending", "partial", "paid", "overdue", "waived", "cancelled"), overdueNotifiedAt: T.DATE(3),
    }),
    RentAllocation: d("RentAllocation", "rent_allocations", { id: pk(), tenantId: tid(), paymentId: tid(), rentScheduleId: tid(), amount: money(false), createdAt: dt3() }, noTs2),
    SecurityDeposit: d("SecurityDeposit", "security_deposits", { id: pk(), tenantId: tid(), leaseId: tid(), amount: money(false), status: T.ENUM("pending", "held", "released") }),
    DepositMovement: d("DepositMovement", "deposit_movements", { id: pk(), tenantId: tid(), depositId: tid(), kind: T.ENUM("collect", "deduct", "refund"), amount: money(false), reason: s(255), paymentId: uuid(), actorId: s(64), createdAt: dt3() }, noTs2),
    LeaseMilestone: d("LeaseMilestone", "lease_milestones", { id: pk(), tenantId: tid(), leaseId: tid(), kind: s(30, false), createdAt: dt3() }, noTs2),
    Vendor: d("Vendor", "vendors", { id: pk(), tenantId: tid(), name: s(180, false), categories: T.JSON, contactName: s(120), phoneE164: s(32), email: s(254), tradeLicenceNo: s(80), licenceExpiresOn: DN(), status: T.ENUM("active", "suspended") }),
    Ticket: d("Ticket", "maintenance_tickets", {
      id: pk(), tenantId: tid(), unitId: tid(), leaseId: uuid(), portfolioId: uuid(), branchId: uuid(), reporterContactId: uuid(), assignedUserId: uuid(),
      category: T.ENUM("plumbing", "electrical", "hvac", "appliance", "structural", "cleaning", "pest", "other"), priority: T.ENUM("urgent", "high", "normal", "low"),
      status: T.ENUM("new", "triaged", "quoted", "approved", "in_progress", "completed", "closed", "cancelled"), title: s(255, false), description: T.TEXT,
      slaDueAt: dt3(), slaBreachedAt: T.DATE(3), resolvedAt: T.DATE(3), createdBy: s(64),
    }),
    Quotation: d("Quotation", "quotations", { id: pk(), tenantId: tid(), ticketId: tid(), vendorId: tid(), amount: money(false), currency: s(3, false), status: T.ENUM("submitted", "approved", "rejected"), notes: s(500), decidedBy: s(64), decidedAt: T.DATE(3) }),
    WorkOrder: d("WorkOrder", "work_orders", { id: pk(), tenantId: tid(), ticketId: tid(), vendorId: tid(), quotationId: uuid(), scheduledAt: T.DATE(3), completedAt: T.DATE(3), status: T.ENUM("issued", "in_progress", "completed", "cancelled"), quotedAmount: money(), finalCost: money(), currency: s(3, false) }),
    WorkOrderEvent: d("WorkOrderEvent", "work_order_events", { id: pk(), tenantId: tid(), workOrderId: uuid(), ticketId: tid(), type: s(40, false), detail: T.JSON, actorId: s(64), createdAt: dt3() }, noTs2),
    InspectionTemplate: d("InspectionTemplate", "inspection_templates", { id: pk(), tenantId: tid(), name: s(160, false), kind: T.ENUM("move_in", "move_out", "periodic"), items: { type: T.JSON, allowNull: false } }),
    Inspection: d("Inspection", "inspections", {
      id: pk(), tenantId: tid(), unitId: tid(), leaseId: uuid(), templateId: uuid(), inspectorUserId: tid(), branchId: uuid(), portfolioId: uuid(), kind: T.ENUM("move_in", "move_out", "periodic"),
      status: T.ENUM("scheduled", "in_progress", "completed", "signed"), version: T.INTEGER, scheduledFor: T.DATE(3), completedAt: T.DATE(3), signedByContactId: uuid(), signedAt: T.DATE(3), summary: T.TEXT,
    }),
    InspectionItem: d("InspectionItem", "inspection_items", { id: pk(), tenantId: tid(), inspectionId: tid(), label: s(200, false), area: s(80), condition: T.ENUM("good", "fair", "poor", "damaged", "na"), notes: s(1000), meterReading: T.DECIMAL(12, 2), version: T.INTEGER }),
    InspectionMedia: d("InspectionMedia", "inspection_media", { id: pk(), tenantId: tid(), inspectionId: tid(), itemId: uuid(), documentId: tid(), createdAt: dt3() }, noTs2),
    InspectionMutation: d("InspectionMutation", "inspection_mutations", { id: pk(), tenantId: tid(), inspectionId: tid(), clientMutationId: s(80, false), appliedVersion: T.INTEGER, createdAt: dt3() }, noTs2),
    OwnerStatement: d("OwnerStatement", "owner_statements", {
      id: pk(), tenantId: tid(), portfolioId: tid(), period: s(7, false), rentCollected: money(false), managementFee: money(false), maintenanceCost: money(false), netPayable: money(false),
      currency: s(3, false), detail: T.JSON, status: T.ENUM("draft", "issued"), issuedAt: T.DATE(3),
    }),
    KycProfile: d("KycProfile", "kyc_profiles", {
      id: pk(), tenantId: tid(), contactId: tid(), subjectType: T.ENUM("individual", "entity"), status: T.ENUM("draft", "in_review", "approved", "rejected", "expired"),
      riskLevel: T.ENUM("low", "medium", "high", "unrated"), riskScore: T.INTEGER, riskFactors: T.JSON, isPep: T.BOOLEAN, nationality: s(60), countryOfResidence: s(60),
      idType: s(40), idNumberEnc: T.TEXT, idNumberLast4: s(4), dateOfBirthEnc: T.TEXT, sourceOfFunds: s(500), occupation: s(160), expiresAt: T.DATEONLY,
      submittedAt: T.DATE(3), submittedBy: s(64), reviewedBy: s(64), reviewedAt: T.DATE(3), decisionReason: s(500),
    }),
    KycDocument: d("KycDocument", "kyc_documents", { id: pk(), tenantId: tid(), profileId: tid(), documentId: tid(), docType: T.ENUM("passport", "emirates_id", "visa", "trade_licence", "proof_of_address", "source_of_funds", "other"), expiresOn: T.DATEONLY }),
    UboLink: d("UboLink", "ubo_links", { id: pk(), tenantId: tid(), parentContactId: tid(), ownerContactId: tid(), ownershipPct: T.DECIMAL(6, 3), relation: T.ENUM("shareholder", "director", "controller", "trustee") }),
    ScreeningRun: d("ScreeningRun", "screening_runs", { id: pk(), tenantId: tid(), profileId: tid(), provider: s(40, false), status: T.ENUM("completed", "failed"), hitCount: T.INTEGER, subjects: T.JSON, triggeredBy: s(64), createdAt: dt3() }, noTs2),
    ScreeningHit: d("ScreeningHit", "screening_hits", {
      id: pk(), tenantId: tid(), runId: tid(), profileId: tid(), subjectContactId: tid(), listName: s(80, false), matchedName: s(200, false), score: T.INTEGER, detail: T.JSON,
      status: T.ENUM("open", "true_match", "false_positive"), disposedBy: s(64), disposedReason: s(1000), disposedAt: T.DATE(3),
    }),
    ComplianceCase: d("ComplianceCase", "compliance_cases", {
      id: pk(), tenantId: tid(), profileId: tid(), kind: T.ENUM("screening_hit", "high_risk", "suspicious_activity", "document_issue", "other"), status: T.ENUM("open", "escalated", "closed"),
      outcome: T.ENUM("cleared", "reported", "rejected"), summary: s(1000, false), assignedUserId: uuid(), openedBy: s(64), closedBy: s(64), closedAt: T.DATE(3), resolution: s(1000),
    }),
    CaseEvent: d("CaseEvent", "case_events", { id: pk(), tenantId: tid(), caseId: tid(), type: s(40, false), detail: T.JSON, actorId: s(64), createdAt: dt3() }, noTs2),
    DsrRequest: d("DsrRequest", "dsr_requests", {
      id: pk(), tenantId: tid(), contactId: tid(), kind: T.ENUM("access", "rectification", "erasure", "restriction"), status: T.ENUM("received", "completed", "rejected"), dueAt: dt3(),
      note: s(1000), handledBy: s(64), completedAt: T.DATE(3), result: T.JSON, overdueNotifiedAt: T.DATE(3),
    }),
    RetentionPolicy: d("RetentionPolicy", "retention_policies", { id: pk(), tenantId: tid(), entityType: T.ENUM("contact_archived", "kyc_profile", "message"), retainDays: T.INTEGER, action: T.ENUM("anonymise", "delete_content") }),
    LegalHold: d("LegalHold", "legal_holds", { id: pk(), tenantId: tid(), contactId: tid(), reason: s(500, false), placedBy: s(64), releasedBy: s(64), releasedAt: T.DATE(3) }),
    ScoringModel: d("ScoringModel", "scoring_models", {
      id: pk(), tenantId: tid(), version: T.INTEGER, kind: T.ENUM("rules", "logistic"), status: T.ENUM("draft", "active", "retired"), definition: { type: T.JSON, allowNull: false },
      metrics: T.JSON, trainedOn: T.INTEGER, createdBy: s(64), activatedAt: T.DATE(3),
    }),
    LeadScore: d("LeadScore", "lead_scores", {
      id: pk(), tenantId: tid(), leadId: tid(), modelId: tid(), modelVersion: T.INTEGER, score: T.INTEGER, band: T.ENUM("hot", "warm", "cold"),
      reasons: { type: T.JSON, allowNull: false }, features: { type: T.JSON, allowNull: false }, createdAt: dt3(),
    }, noTs2),
    Bot: d("Bot", "bots", { id: pk(), tenantId: tid(), name: s(160, false), channel: T.ENUM("whatsapp", "sms", "email"), status: T.ENUM("draft", "published", "disabled"), currentVersion: T.INTEGER, draftGraph: T.JSON }),
    BotVersion: d("BotVersion", "bot_versions", { id: pk(), tenantId: tid(), botId: tid(), version: T.INTEGER, graph: { type: T.JSON, allowNull: false }, createdBy: s(64), createdAt: dt3() }, noTs2),
    BotSession: d("BotSession", "bot_sessions", {
      id: pk(), tenantId: tid(), botId: tid(), botVersion: T.INTEGER, contactId: tid(), conversationId: uuid(), leadId: uuid(), status: T.ENUM("active", "handed_off", "completed"),
      currentNode: s(80), vars: T.JSON, aiTokensUsed: T.INTEGER, stepCount: T.INTEGER, handoffReason: s(255),
    }),
    BotSessionEvent: d("BotSessionEvent", "bot_session_events", { id: pk(), tenantId: tid(), sessionId: tid(), direction: T.ENUM("user", "bot", "system"), nodeId: s(80), text: T.TEXT, detail: T.JSON, createdAt: dt3() }, noTs2),
    SsoConnection: d("SsoConnection", "sso_connections", {
      id: pk(), tenantId: tid(), name: s(120, false), protocol: T.ENUM("oidc"), issuer: s(255, false), clientId: s(255, false), clientSecretEnc: T.TEXT, authorizationEndpoint: s(500, false),
      tokenEndpoint: s(500, false), jwksUri: s(500, false), emailDomains: { type: T.JSON, allowNull: false }, jitEnabled: T.BOOLEAN, jitRoleKey: s(60), trustIdpMfa: T.BOOLEAN, enforce: T.BOOLEAN,
      status: T.ENUM("active", "disabled"),
    }),
    SsoState: d("SsoState", "sso_states", {
      id: pk(), tenantId: tid(), connectionId: tid(), stateHash: s(64, false), nonce: s(64, false), codeVerifierEnc: { type: T.TEXT, allowNull: false }, redirectUri: s(500, false),
      loginHint: s(254), expiresAt: dt3(), usedAt: T.DATE(3), createdAt: dt3(),
    }, noTs2),
    DataProcessingPolicy: d("DataProcessingPolicy", "data_processing_policies", { id: pk(), tenantId: tid(), allowedRegions: { type: T.JSON, allowNull: false }, allowCrossBorder: T.BOOLEAN, requireRegisteredProviders: T.BOOLEAN, updatedBy: s(64) }),
    Subprocessor: d("Subprocessor", "subprocessors", { id: pk(), tenantId: tid(), code: s(60, false), name: s(160, false), purpose: s(255, false), region: s(32, false), status: T.ENUM("approved", "pending", "blocked"), dpaSignedOn: T.DATEONLY }),
    MobileDevice: d("MobileDevice", "mobile_devices", { id: pk(), tenantId: tid(), userId: tid(), deviceId: s(80, false), name: s(120), platform: T.ENUM("ios", "android", "web"), status: T.ENUM("active", "revoked"), lastSyncAt: T.DATE(3), revokedAt: T.DATE(3) }),
    MobileMutation: d("MobileMutation", "mobile_mutations", { id: pk(), tenantId: tid(), deviceId: tid(), clientMutationId: s(80, false), kind: s(60, false), status: T.ENUM("applied", "conflict", "rejected"), result: T.JSON, createdAt: dt3() }, noTs2),
    SavedSearch: d("SavedSearch", "saved_searches", { id: pk(), tenantId: tid(), name: s(160, false), ownerUserId: tid(), contactId: uuid(), leadId: uuid(), criteria: { type: T.JSON, allowNull: false }, notify: T.BOOLEAN, status: T.ENUM("active", "paused"), lastRunAt: T.DATE(3) }),
    PropertyMatch: d("PropertyMatch", "property_matches", { id: pk(), tenantId: tid(), leadId: tid(), listingId: tid(), score: T.INTEGER, reasons: { type: T.JSON, allowNull: false }, status: T.ENUM("new", "shared", "dismissed") }),
    Notification: d("Notification", "notifications", { id: pk(), tenantId: tid(), userId: tid(), kind: s(40, false), title: s(200, false), body: s(500), entityType: s(40), entityId: uuid(), dedupeKey: s(120), readAt: T.DATE(3), createdAt: dt3() }, noTs2),
    ReferralPartner: d("ReferralPartner", "referral_partners", { id: pk(), tenantId: tid(), name: s(160, false), kind: T.ENUM("broker", "developer", "bank", "corporate", "individual"), contactId: uuid(), feePct: T.DECIMAL(5, 2), status: T.ENUM("active", "inactive") }),
    Referral: d("Referral", "referrals", {
      id: pk(), tenantId: tid(), partnerId: tid(), leadId: tid(), dealId: uuid(), feePct: T.DECIMAL(5, 2), status: T.ENUM("submitted", "won", "paid", "void"), feeAmount: money(), currency: s(3, false),
      settledAt: T.DATE(3), paidAt: T.DATE(3), note: s(500),
    }),
    Valuation: d("Valuation", "valuations", { id: pk(), tenantId: tid(), unitId: tid(), estimate: money(false), low: money(false), high: money(false), pricePerSqft: money(false), confidence: T.ENUM("low", "medium", "high"), comps: { type: T.JSON, allowNull: false }, method: s(80), createdBy: s(64), createdAt: dt3() }, noTs2),
    AuthToken: d("AuthToken", "auth_tokens", { id: pk(), tenantId: tid(), userId: tid(), kind: T.ENUM("password_reset", "invite"), tokenHash: s(64, false), expiresAt: dt3(), usedAt: T.DATE(3), createdAt: dt3() }, noTs2),
    ImportJob: d("ImportJob", "import_jobs", {
      id: pk(), tenantId: tid(), kind: T.ENUM("contacts", "leads", "units"), filename: s(255, false), createdBy: tid(), status: T.ENUM("validated", "committed", "failed", "cancelled"),
      totalRows: T.INTEGER, validRows: T.INTEGER, errorRows: T.INTEGER, committedRows: T.INTEGER, skippedRows: T.INTEGER, payload: T.JSON, errors: T.JSON, options: T.JSON,
    }),
    PortalLink: d("PortalLink", "portal_links", { id: pk(), tenantId: tid(), userId: tid(), contactId: tid(), kind: T.ENUM("owner", "tenant"), status: T.ENUM("active", "revoked") }),
  });
  cache.set(sq, m);
  return m;
}
