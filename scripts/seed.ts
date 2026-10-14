import "dotenv/config";
import { randomBytes } from "node:crypto";
import { QueryTypes } from "sequelize";
import { closeSequelize, getSequelize } from "../packages/database/src";
import { bootstrapTenant, assignOwnership, createBranch, createBuilding, createContact, createLease, createPortfolio, createTicket, createVendor, createManagementAgreement, createBusinessUnit, createDeveloper, createListing, createPortalAccount, createProject, createReProject, createRoutingRule, createUnit, createUser } from "../packages/domain/src";
import { loadAccess } from "../packages/rbac/src";

/** Dev seed: a demo tenant with an org tree, a few users and projects. Passwords are printed once. */
async function main() {
  const sq = getSequelize();
  const slug = process.env.SEED_TENANT ?? "demo";
  const [existing] = await sq.query("SELECT id FROM tenants WHERE slug=:slug", { replacements: { slug }, type: QueryTypes.SELECT });
  if (existing) { console.log(`Tenant "${slug}" already exists - nothing to do.`); return; }

  const pw = () => randomBytes(9).toString("base64url") + "aA1!";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? pw();
  const t = await bootstrapTenant(sq, { name: "Demo Realty", slug, adminEmail: `admin@${slug}.example`, adminPassword });
  const access = await loadAccess(sq, t.tenantId, t.adminId);
  const ctx = { tenantId: t.tenantId, userId: t.adminId, sessionId: "seed", correlationId: "corr_seed", grants: access.grants, membership: access.membership, stepUpValid: true };

  const bu = await createBusinessUnit(sq, ctx, { name: "Brokerage", type: "brokerage" });
  const marina = await createBranch(sq, ctx, { businessUnitId: bu.id, name: "Dubai Marina", city: "Dubai" });
  await createBranch(sq, ctx, { businessUnitId: bu.id, name: "Business Bay", city: "Dubai" });
  await createProject(sq, ctx, { code: "PALM", name: "Palm Residences" });
  await createProject(sq, ctx, { code: "DTWN", name: "Downtown Towers" });

  const managerPw = pw();
  const agentPw = pw();
  await createUser(sq, ctx, { email: `manager@${slug}.example`, password: managerPw, roleKeys: ["branch_manager"], businessUnitId: bu.id, branchId: marina.id });
  const agent = await createUser(sq, ctx, { email: `agent@${slug}.example`, password: agentPw, roleKeys: ["agent"], businessUnitId: bu.id, branchId: marina.id });

  // Demo CRM data: routing, portals, a ready Dubai project with units and a draft listing (not yet publishable: no permit or licence).
  await createRoutingRule(sq, ctx, { name: "Marina team", priority: 10, conditions: {}, target: { branchId: marina.id }, strategy: "round_robin" });
  await createPortalAccount(sq, ctx, { provider: "bayut", name: "Bayut (export)" });
  await createPortalAccount(sq, ctx, { provider: "property_finder", name: "Property Finder (export)" });
  const dev = await createDeveloper(sq, ctx, { name: "Demo Developments", jurisdictionCode: "DUBAI_MAINLAND", registrationNo: "DEV-1001", escrowRegistered: true });
  const rp = await createReProject(sq, ctx, { name: "Marina Heights", jurisdictionCode: "DUBAI_MAINLAND", kind: "ready", developerId: dev.id, registrationNo: "PRJ-2001" });
  const bldg = await createBuilding(sq, ctx, { reProjectId: rp.id, name: "Tower A", community: "Dubai Marina", city: "Dubai", floorsCount: 40 });
  const unit = await createUnit(sq, ctx, { buildingId: bldg.id, unitNumber: "1204", floor: 12, type: "apartment", bedrooms: 2, bathrooms: 2, areaSqft: 1250, view: "Marina", listPrice: 2100000 });
  await createUnit(sq, ctx, { buildingId: bldg.id, unitNumber: "2301", floor: 23, type: "apartment", bedrooms: 3, bathrooms: 3, areaSqft: 1800, view: "Sea", listPrice: 3400000 });
  const rentable = await createUnit(sq, ctx, { buildingId: bldg.id, unitNumber: "0507", floor: 5, type: "apartment", bedrooms: 1, bathrooms: 1, areaSqft: 780, listPrice: 1250000 });
  await createListing(sq, ctx, { unitId: unit.id, purpose: "sale", title: "Marina view 2BR, Tower A", description: "Bright two-bedroom with marina views.", price: 2100000, agentUserId: agent.id, branchId: marina.id });

  console.log(`\nSeeded tenant "${slug}" (sign in with workspace = ${slug})`);
  console.log(`  admin@${slug}.example    ${adminPassword}   (MFA enrolment required on first sign-in)`);
  console.log(`  manager@${slug}.example  ${managerPw}   (MFA enrolment required)`);
  console.log(`  agent@${slug}.example    ${agentPw}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());
