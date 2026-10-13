import { addBrokerLicence, createBranch, createBuilding, createBusinessUnit, createDeveloper, createListing, createReProject, createUnit, verifyBrokerLicence } from "@reales/domain";
import { makeTenant, makeUser, testDb, uniq } from "./helpers";

export type Tenant = Awaited<ReturnType<typeof makeTenant>>;
const sq = () => testDb();
export const dateOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** One business unit with two branches. */
export async function makeOrg(t: Tenant) {
  const bu = await createBusinessUnit(sq(), t.admin, { name: "Brokerage", type: "brokerage" });
  const marina = await createBranch(sq(), t.admin, { businessUnitId: bu.id, name: "Marina", city: "Dubai" });
  const bay = await createBranch(sq(), t.admin, { businessUnitId: bu.id, name: "Business Bay", city: "Dubai" });
  return { bu, marina, bay };
}

export interface KitOptions {
  jurisdiction?: string; kind?: "ready" | "off_plan"; registrationNo?: string | null; escrowAccountRef?: string | null;
  unit?: Partial<{ areaSqft: number; type: "apartment"; bedrooms: number; listPrice: number }>;
}

/** Developer -> project -> building -> unit, in the requested jurisdiction. */
export async function makeInventory(t: Tenant, o: KitOptions = {}) {
  const jurisdictionCode = o.jurisdiction ?? "DUBAI_MAINLAND";
  const dev = await createDeveloper(sq(), t.admin, { name: uniq("Dev"), jurisdictionCode, escrowRegistered: true });
  const project = await createReProject(sq(), t.admin, {
    name: uniq("Tower"), jurisdictionCode, kind: o.kind ?? "ready", developerId: dev.id,
    registrationNo: o.registrationNo === null ? undefined : o.registrationNo ?? "PRJ-1001",
    escrowAccountRef: o.escrowAccountRef === null ? undefined : o.escrowAccountRef ?? "ESC-77",
  });
  const building = await createBuilding(sq(), t.admin, { reProjectId: project.id, name: uniq("Bldg"), community: "Marina", city: "Dubai" });
  const unit = await createUnit(sq(), t.admin, { buildingId: building.id, unitNumber: uniq("U").slice(0, 12), type: "apartment", bedrooms: 2, bathrooms: 2, areaSqft: 1200, listPrice: 2_000_000, ...(o.unit ?? {}) });
  return { dev, project, building, unit, jurisdictionCode };
}

/** A fully valid company licence for the jurisdiction's accepted authority, verified. */
export async function makeVerifiedLicences(t: Tenant, agentId: string, authority = "DLD_RERA", expiresAt = dateOffset(365)) {
  const company = await addBrokerLicence(sq(), t.admin, { holderType: "company", holderName: "Demo Brokerage LLC", licenceNo: uniq("CO"), authority, expiresAt });
  await verifyBrokerLicence(sq(), t.admin, company.id, "valid");
  const agent = await addBrokerLicence(sq(), t.admin, { holderType: "agent", holderName: "Agent", userId: agentId, licenceNo: uniq("AG"), authority, expiresAt });
  await verifyBrokerLicence(sq(), t.admin, agent.id, "valid");
  return { company, agent };
}

export async function makeListing(t: Tenant, kit: Awaited<ReturnType<typeof makeInventory>>, agentId: string, brokerLicenceId?: string) {
  return createListing(sq(), t.admin, {
    unitId: kit.unit.id, purpose: "sale", title: "Sea view 2BR in Marina", description: "Bright apartment with full marina views.",
    price: 2_100_000, agentUserId: agentId, brokerLicenceId,
  });
}

export async function agentIn(t: Tenant, branchId: string, buId: string, role = "agent") {
  return makeUser(t, [role], { branchId, businessUnitId: buId });
}
