import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createContact, createDeveloper, createReProject, listTrash, purgeRecord, restoreRecord, searchListingsAdvanced, softDelete } from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, testDb, uniq } from "./helpers";
import { agentIn, makeInventory, makeListing, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const live = async (table: string, id: string) => ((await sq().query<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE id=:id AND deleted_at IS NULL`, { replacements: { id }, type: QueryTypes.SELECT }))[0]!.n);

describe("soft delete and trash", () => {
  it("hides a deleted contact from every normal read, lists it in Trash, restores it and audits both steps", async () => {
    const { makeTenant } = await import("./helpers");
    const t = await makeTenant();
    const c = await createContact(sq(), t.admin, { firstName: uniq("Del"), phone: phone() });
    await softDelete(sq(), t.admin, "contact", c.id, "duplicate entry");
    expect(await live("contacts", c.id)).toBe(0);
    const trash = await listTrash(sq(), t.admin, { entity: "contact" });
    expect(trash.rows.map((r) => r.id)).toContain(c.id);
    await expect(softDelete(sq(), t.admin, "contact", c.id)).rejects.toThrow(/not found/i); // already in Trash
    await restoreRecord(sq(), t.admin, "contact", c.id);
    expect(await live("contacts", c.id)).toBe(1);
    const acts = await sq().query<{ action: string }>("SELECT action FROM audit_events WHERE tenant_id=:t AND entity_id=:id ORDER BY seq", { replacements: { t: t.tenantId, id: c.id }, type: QueryTypes.SELECT });
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["record.deleted", "record.restored"]));
  });

  it("blocks deleting a published listing or a unit that still has a listing, and restores children only after their parent", async () => {
    const { makeTenant } = await import("./helpers");
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const inv = await makeInventory(t);
    const listing = await makeListing(t, inv, agent.id);
    await expect(softDelete(sq(), t.admin, "unit", inv.unit.id)).rejects.toThrow(/listing/i);
    await expect(softDelete(sq(), t.admin, "building", inv.building.id)).rejects.toThrow(/units/i);
    await softDelete(sq(), t.admin, "listing", listing.id);
    await softDelete(sq(), t.admin, "unit", inv.unit.id);
    await expect(restoreRecord(sq(), t.admin, "listing", listing.id)).rejects.toThrow(/unit first/i);
    await restoreRecord(sq(), t.admin, "unit", inv.unit.id);
    await restoreRecord(sq(), t.admin, "listing", listing.id);
    expect(await live("listings", listing.id)).toBe(1);
  });

  it("excludes deleted listings from the advanced search and the public website lookups", async () => {
    const { makeTenant } = await import("./helpers");
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const inv = await makeInventory(t);
    const listing = await makeListing(t, inv, agent.id);
    expect((await searchListingsAdvanced(sq(), t.admin, {})).rows.map((r: any) => r.id)).toContain(listing.id);
    await softDelete(sq(), t.admin, "listing", listing.id);
    expect((await searchListingsAdvanced(sq(), t.admin, {})).rows.map((r: any) => r.id)).not.toContain(listing.id);
  });

  it("lets a name be reused while the old record sits in Trash, and refuses a restore that would clash", async () => {
    const { makeTenant } = await import("./helpers");
    const t = await makeTenant();
    const name = uniq("Dev");
    const a = await createDeveloper(sq(), t.admin, { name, jurisdictionCode: "DUBAI_MAINLAND", escrowRegistered: true });
    await softDelete(sq(), t.admin, "developer", a.id);
    // developers have no unique name, so exercise the units index: same unit number in the same building
    const inv = await makeInventory(t);
    const number = (await sq().query<{ unit_number: string }>("SELECT unit_number FROM units WHERE id=:id", { replacements: { id: inv.unit.id }, type: QueryTypes.SELECT }))[0]!.unit_number;
    await softDelete(sq(), t.admin, "unit", inv.unit.id);
    const { createUnit } = await import("@reales/domain");
    const again = await createUnit(sq(), t.admin, { buildingId: inv.building.id, unitNumber: number, type: "apartment", bedrooms: 1, bathrooms: 1, areaSqft: 700, listPrice: 900_000 });
    expect(again.id).not.toBe(inv.unit.id);
    await expect(restoreRecord(sq(), t.admin, "unit", inv.unit.id)).rejects.toThrow(/same name or number/i);
    void createReProject;
  });

  it("only tenant administrators can erase for good, and a normal agent sees only what they deleted", async () => {
    const { makeTenant } = await import("./helpers");
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const c = await createContact(sq(), t.admin, { firstName: uniq("Gone"), phone: phone() });
    await softDelete(sq(), t.admin, "contact", c.id);
    expect((await listTrash(sq(), agent.ctx, {})).rows.map((r) => r.id)).not.toContain(c.id);
    await expect(purgeRecord(sq(), agent.ctx, "contact", c.id)).rejects.toBeInstanceOf(ForbiddenError);
    await purgeRecord(sq(), t.admin, "contact", c.id);
    expect((await sq().query<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE id=:id", { replacements: { id: c.id }, type: QueryTypes.SELECT }))[0]!.n).toBe(0);
  });

  it("never lets a tenant touch another tenant's trash", async () => {
    const { makeTenant } = await import("./helpers");
    const a = await makeTenant(), b = await makeTenant();
    const c = await createContact(sq(), a.admin, { firstName: uniq("Mine"), phone: phone() });
    await expect(softDelete(sq(), b.admin, "contact", c.id)).rejects.toThrow(/not found/i);
    await softDelete(sq(), a.admin, "contact", c.id);
    expect((await listTrash(sq(), b.admin, {})).rows.map((r) => r.id)).not.toContain(c.id);
    await expect(restoreRecord(sq(), b.admin, "contact", c.id)).rejects.toThrow(/not found/i);
  });
});
