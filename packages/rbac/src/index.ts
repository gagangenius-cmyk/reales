import { QueryTypes, Sequelize } from "sequelize";
import type { Grant, RequestContext, ScopeType } from "@reales/database";

/** Explicit permission catalogue. Application code checks permissions, never role names. */
export const PERMISSIONS = {
  "tenant.manage": "Manage tenant settings, plan, quotas",
  "user.read": "View users",
  "user.create": "Invite/create users",
  "user.update": "Update users, disable/enable",
  "role.read": "View roles and permissions",
  "role.manage": "Create roles and assign permissions/roles",
  "org.read": "View business units, branches, teams",
  "org.manage": "Manage business units, branches, teams",
  "project.read": "View projects/portfolios",
  "project.manage": "Manage projects/portfolios",
  "audit.read": "View audit log",
  "session.manage": "Revoke other users' sessions",
  // CRM / brokerage (phase 2)
  "contact.read": "View contacts", "contact.create": "Create contacts", "contact.update": "Update contacts",
  "consent.manage": "Record consent and manage suppression lists",
  "lead.read": "View leads", "lead.create": "Create leads", "lead.update": "Update leads and change stages", "lead.assign": "Assign or reassign leads",
  "pipeline.manage": "Manage pipelines and stages", "routing.manage": "Manage lead routing rules",
  "inventory.read": "View developers, projects, buildings, units", "inventory.manage": "Manage developers, projects, buildings, units",
  "listing.read": "View listings", "listing.manage": "Create and edit listings", "listing.publish": "Publish listings to portals",
  "portal.manage": "Manage portal accounts", "compliance.verify": "Verify permits and broker licences",
  // Transactions (phase 3)
  "viewing.read": "View viewings", "viewing.manage": "Book and manage viewings",
  "offer.read": "View offers", "offer.manage": "Create and negotiate offers", "offer.approve": "Accept offers (manager approval)",
  "reservation.manage": "Create, cancel and expire unit reservations",
  "deal.read": "View deals", "deal.create": "Start deals from reservations", "deal.update": "Advance deals and complete milestones", "deal.close": "Close or cancel deals and override milestones",
  "document.read": "View documents", "document.manage": "Upload and manage documents", "signature.manage": "Send documents for signature",
  "finance.read": "View invoices and payments", "finance.manage": "Create and issue invoices", "payment.record": "Record payments and allocate them",
  "commission.read": "View commissions", "commission.approve": "Approve commissions", "commission.plan.manage": "Manage commission plans",
  // Communications and automation (phase 4)
  "template.read": "View templates", "template.manage": "Create and edit templates", "template.approve": "Approve templates for sending",
  "inbox.read": "View conversations", "inbox.send": "Send messages", "channel.manage": "Manage channel accounts",
  "campaign.read": "View campaigns", "campaign.manage": "Create, schedule and control broadcasts", "segment.manage": "Manage audience segments",
  "workflow.read": "View workflows", "workflow.manage": "Edit and publish workflows",
  // Property management (phase 5)
  "portfolio.read": "View owner portfolios", "portfolio.manage": "Manage portfolios, ownership and agreements",
  "lease.read": "View leases and rent schedules", "lease.manage": "Create, activate, renew leases", "lease.terminate": "Terminate leases and override renewal limits",
  "rent.record": "Record rent payments", "deposit.manage": "Collect, deduct and refund security deposits",
  "maintenance.read": "View maintenance tickets", "maintenance.manage": "Triage tickets, request quotes, issue work orders", "maintenance.approve": "Approve costly maintenance quotations",
  "vendor.manage": "Manage vendors", "inspection.read": "View inspections", "inspection.perform": "Perform inspections", "inspection.manage": "Create inspections and templates",
  "statement.read": "View owner statements", "statement.generate": "Generate and issue owner statements",
  // Reserved for later phases (declared now so role templates are stable)
  "compliance.override": "Override compliance decisions",
} as const;
export type PermissionKey = keyof typeof PERMISSIONS;

export interface RoleTemplate {
  key: string;
  name: string;
  requiresMfa: boolean;
  grants: Array<[PermissionKey, ScopeType]>;
}

const ALL_TENANT: Array<[PermissionKey, ScopeType]> = (Object.keys(PERMISSIONS) as PermissionKey[]).map((k) => [k, "tenant"]);

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { key: "tenant_admin", name: "Tenant Administrator", requiresMfa: true, grants: ALL_TENANT },
  {
    key: "branch_manager", name: "Branch Manager", requiresMfa: true,
    grants: [
      ["user.read", "branch"], ["org.read", "tenant"], ["project.read", "tenant"],
      ["contact.read", "branch"], ["contact.create", "tenant"], ["contact.update", "branch"],
      ["lead.read", "branch"], ["lead.create", "tenant"], ["lead.update", "branch"], ["lead.assign", "branch"],
      ["routing.manage", "tenant"], ["pipeline.manage", "tenant"], ["inventory.read", "tenant"], ["inventory.manage", "tenant"],
      ["listing.read", "branch"], ["listing.manage", "branch"], ["listing.publish", "branch"], ["portal.manage", "tenant"],
      ["compliance.verify", "branch"], ["commission.read", "branch"],
      ["viewing.read", "branch"], ["viewing.manage", "branch"], ["offer.read", "branch"], ["offer.manage", "branch"], ["offer.approve", "branch"], ["reservation.manage", "tenant"],
      ["deal.read", "branch"], ["deal.create", "tenant"], ["deal.update", "branch"], ["deal.close", "branch"],
      ["document.read", "branch"], ["document.manage", "branch"], ["signature.manage", "branch"], ["finance.read", "branch"],
      ["template.read", "tenant"], ["template.manage", "tenant"], ["template.approve", "tenant"], ["inbox.read", "branch"], ["inbox.send", "branch"],
      ["campaign.read", "tenant"], ["campaign.manage", "tenant"], ["segment.manage", "tenant"], ["workflow.read", "tenant"], ["workflow.manage", "tenant"], ["channel.manage", "tenant"],
    ],
  },
  {
    key: "senior_broker", name: "Senior Broker", requiresMfa: false,
    grants: [
      ["contact.read", "branch"], ["contact.create", "tenant"], ["contact.update", "own_records"],
      ["lead.read", "branch"], ["lead.create", "tenant"], ["lead.update", "own_records"],
      ["inventory.read", "tenant"], ["listing.read", "branch"], ["listing.manage", "own_records"], ["listing.publish", "project"],
      ["commission.read", "own_records"], ["project.read", "tenant"],
      ["viewing.read", "branch"], ["viewing.manage", "own_records"], ["offer.read", "branch"], ["offer.manage", "own_records"],
      ["deal.read", "branch"], ["deal.update", "own_records"], ["document.read", "branch"], ["document.manage", "own_records"],
      ["template.read", "tenant"], ["inbox.read", "own_records"], ["inbox.send", "own_records"],
    ],
  },
  {
    key: "agent", name: "Sales Agent", requiresMfa: false,
    grants: [
      ["contact.read", "own_records"], ["contact.create", "tenant"], ["contact.update", "own_records"],
      ["lead.read", "own_records"], ["lead.create", "tenant"], ["lead.update", "own_records"],
      ["inventory.read", "tenant"], ["listing.read", "branch"], ["listing.manage", "own_records"],
      ["commission.read", "own_records"], ["project.read", "tenant"],
      ["viewing.read", "own_records"], ["viewing.manage", "own_records"], ["offer.read", "own_records"], ["offer.manage", "own_records"],
      ["deal.read", "own_records"], ["deal.update", "own_records"], ["document.read", "own_records"], ["document.manage", "own_records"],
      ["template.read", "tenant"], ["inbox.read", "own_records"], ["inbox.send", "own_records"],
    ],
  },
  {
    key: "compliance_officer", name: "AML/Compliance Officer", requiresMfa: true,
    grants: [
      ["audit.read", "tenant"], ["compliance.override", "tenant"], ["compliance.verify", "tenant"], ["consent.manage", "tenant"],
      ["user.read", "tenant"], ["lead.read", "tenant"], ["contact.read", "tenant"], ["listing.read", "tenant"],
    ],
  },
  {
    key: "finance_officer", name: "Finance Officer", requiresMfa: true,
    grants: [
      ["commission.read", "tenant"], ["commission.approve", "tenant"], ["commission.plan.manage", "tenant"], ["project.read", "tenant"],
      ["finance.read", "tenant"], ["finance.manage", "tenant"], ["payment.record", "tenant"], ["deal.read", "tenant"], ["document.read", "tenant"],
    ],
  },
  {
    key: "property_manager", name: "Property Manager", requiresMfa: true,
    grants: [
      ["portfolio.read", "tenant"], ["portfolio.manage", "tenant"], ["lease.read", "tenant"], ["lease.manage", "tenant"], ["lease.terminate", "tenant"], ["rent.record", "tenant"], ["deposit.manage", "tenant"],
      ["maintenance.read", "tenant"], ["maintenance.manage", "tenant"], ["maintenance.approve", "tenant"], ["vendor.manage", "tenant"], ["inspection.read", "tenant"], ["inspection.manage", "tenant"],
      ["statement.read", "tenant"], ["statement.generate", "tenant"], ["contact.read", "tenant"], ["contact.create", "tenant"], ["contact.update", "tenant"], ["inventory.read", "tenant"],
      ["document.read", "tenant"], ["document.manage", "tenant"], ["project.read", "tenant"], ["org.read", "tenant"], ["finance.read", "tenant"],
    ],
  },
  {
    key: "maintenance_coordinator", name: "Maintenance Coordinator", requiresMfa: false,
    grants: [["maintenance.read", "tenant"], ["maintenance.manage", "tenant"], ["vendor.manage", "tenant"], ["inspection.read", "tenant"], ["inventory.read", "tenant"], ["lease.read", "tenant"], ["contact.read", "tenant"]],
  },
  {
    key: "inspector", name: "Inspector", requiresMfa: false,
    grants: [["inspection.read", "own_records"], ["inspection.perform", "own_records"], ["inventory.read", "tenant"], ["maintenance.read", "branch"]],
  },
  { key: "viewer", name: "Read-only", requiresMfa: false, grants: [["project.read", "tenant"], ["org.read", "tenant"]] },
];

/** Idempotently upsert the global permission catalogue. */
export async function seedPermissions(sequelize: Sequelize): Promise<void> {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await sequelize.query(
      "INSERT INTO permissions (id, `key`, description, created_at, updated_at) VALUES (UUID(), :key, :description, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE description = VALUES(description)",
      { replacements: { key, description } },
    );
  }
}

/** Create the system roles for a tenant from the templates. Safe to re-run. */
export async function seedTenantRoles(sequelize: Sequelize, tenantId: string): Promise<Record<string, string>> {
  await seedPermissions(sequelize);
  const roleIds: Record<string, string> = {};
  for (const t of ROLE_TEMPLATES) {
    await sequelize.query(
      "INSERT INTO roles (id, tenant_id, `key`, name, is_system, requires_mfa, created_at, updated_at) VALUES (UUID(), :tenantId, :key, :name, 1, :mfa, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE name = VALUES(name), requires_mfa = VALUES(requires_mfa)",
      { replacements: { tenantId, key: t.key, name: t.name, mfa: t.requiresMfa ? 1 : 0 } },
    );
    const [role] = await sequelize.query<{ id: string }>("SELECT id FROM roles WHERE tenant_id=:tenantId AND `key`=:key", {
      replacements: { tenantId, key: t.key }, type: QueryTypes.SELECT,
    });
    roleIds[t.key] = role!.id;
    for (const [perm, scope] of t.grants) {
      await sequelize.query(
        `INSERT IGNORE INTO role_permissions (id, tenant_id, role_id, permission_id, scope, created_at, updated_at)
         SELECT UUID(), :tenantId, :roleId, p.id, :scope, NOW(3), NOW(3) FROM permissions p WHERE p.\`key\` = :perm`,
        { replacements: { tenantId, roleId: role!.id, perm, scope } },
      );
    }
    // System roles mirror their template exactly: drop grants that the template no longer contains.
    const wanted = new Set(t.grants.map(([p, s]) => `${p}:${s}`));
    const existing = await sequelize.query<{ id: string; perm: string; scope: string }>(
      "SELECT rp.id, p.`key` AS perm, rp.scope FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.tenant_id=:tenantId AND rp.role_id=:roleId",
      { replacements: { tenantId, roleId: role!.id }, type: QueryTypes.SELECT },
    );
    for (const e of existing) {
      if (!wanted.has(`${e.perm}:${e.scope}`)) await sequelize.query("DELETE FROM role_permissions WHERE id=:id AND tenant_id=:tenantId", { replacements: { id: e.id, tenantId } });
    }
  }
  return roleIds;
}

export interface LoadedAccess {
  grants: Grant[];
  requiresMfa: boolean;
  membership: RequestContext["membership"];
}

/** Resolve a user's effective grants + org membership (tenant-scoped queries only). */
export async function loadAccess(sequelize: Sequelize, tenantId: string, userId: string): Promise<LoadedAccess> {
  const rows = await sequelize.query<{ perm: string; scope: ScopeType; anchor_type: string | null; anchor_id: string | null; requires_mfa: number }>(
    `SELECT p.\`key\` AS perm, rp.scope AS scope, ur.anchor_type, ur.anchor_id, r.requires_mfa
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       JOIN role_permissions rp ON rp.role_id = r.id AND rp.tenant_id = ur.tenant_id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.tenant_id = :tenantId AND ur.user_id = :userId`,
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  // An anchored assignment ("senior broker, but only for project A") contributes ONLY the grants whose scope matches the
  // anchor type, pinned to the anchor. Its other grants are ignored: they would otherwise widen access (or be meaningless).
  const grants: Grant[] = [];
  for (const r of rows) {
    if (r.anchor_id) {
      if (r.scope === r.anchor_type) grants.push({ permission: r.perm, scope: r.scope, anchorId: r.anchor_id });
    } else {
      grants.push({ permission: r.perm, scope: r.scope, anchorId: null });
    }
  }
  const [u] = await sequelize.query<{ business_unit_id: string | null; branch_id: string | null }>(
    "SELECT business_unit_id, branch_id FROM users WHERE tenant_id=:tenantId AND id=:userId",
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  const anchors = await sequelize.query<{ anchor_type: string; anchor_id: string }>(
    "SELECT anchor_type, anchor_id FROM user_roles WHERE tenant_id=:tenantId AND user_id=:userId AND anchor_id IS NOT NULL",
    { replacements: { tenantId, userId }, type: QueryTypes.SELECT },
  );
  const pick = (t: string) => anchors.filter((a) => a.anchor_type === t).map((a) => a.anchor_id);
  const membership = {
    businessUnitIds: [...(u?.business_unit_id ? [u.business_unit_id] : []), ...pick("business_unit")],
    branchIds: [...(u?.branch_id ? [u.branch_id] : []), ...pick("branch")],
    projectIds: pick("project"),
    portfolioIds: pick("portfolio"),
  };
  return { grants, requiresMfa: rows.some((r) => !!r.requires_mfa), membership };
}

/** The organisational location of the record being accessed. */
export interface ResourceRef {
  ownerUserId?: string | null;
  businessUnitId?: string | null;
  branchId?: string | null;
  projectId?: string | null;
  portfolioId?: string | null;
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

type Authz = Pick<RequestContext, "userId" | "grants" | "membership">;

function scopeAllows(g: Grant, ctx: Authz, r: ResourceRef | undefined): boolean {
  switch (g.scope) {
    case "tenant":
      return true;
    case "own_records":
      return !!r && !!r.ownerUserId && r.ownerUserId === ctx.userId;
    case "business_unit":
      return !!r?.businessUnitId && (g.anchorId ? g.anchorId === r.businessUnitId : ctx.membership.businessUnitIds.includes(r.businessUnitId));
    case "branch":
      return !!r?.branchId && (g.anchorId ? g.anchorId === r.branchId : ctx.membership.branchIds.includes(r.branchId));
    case "project":
      return !!r?.projectId && (g.anchorId ? g.anchorId === r.projectId : ctx.membership.projectIds.includes(r.projectId));
    case "portfolio":
      return !!r?.portfolioId && (g.anchorId ? g.anchorId === r.portfolioId : ctx.membership.portfolioIds.includes(r.portfolioId));
  }
}

/** True when ANY grant of the permission covers the resource. With no resource, only tenant-wide grants qualify. */
export function can(ctx: Authz, permission: PermissionKey | string, resource?: ResourceRef): boolean {
  return ctx.grants.some((g) => g.permission === permission && scopeAllows(g, ctx, resource));
}

export function authorize(ctx: Authz, permission: PermissionKey | string, resource?: ResourceRef): void {
  if (!can(ctx, permission, resource)) throw new ForbiddenError(`Missing permission: ${permission}`);
}

/** Does the user hold the permission at all (any scope)? Used for menu visibility / list endpoints. */
export function hasPermission(ctx: Authz, permission: PermissionKey | string): boolean {
  return ctx.grants.some((g) => g.permission === permission);
}

/** Widest scope the user holds for a permission - list endpoints use it to build query filters. */
export function widestScope(ctx: Authz, permission: PermissionKey | string): ScopeType | null {
  const order: ScopeType[] = ["tenant", "business_unit", "branch", "portfolio", "project", "own_records"];
  const scopes = ctx.grants.filter((g) => g.permission === permission).map((g) => g.scope);
  return order.find((s) => scopes.includes(s)) ?? null;
}
