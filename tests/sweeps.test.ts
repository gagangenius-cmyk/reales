import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { addListingMedia, addPermit, createListing, createOffer, createReservation, publishListing, runSweeps, verifyPermit } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { dateOffset, makeVerifiedLicences } from "./brokerage-helpers";
import { acceptedOffer, kit } from "./deal-helpers";

afterAll(closeTestDb);
const sq = () => testDb();

describe("deadline sweeps (scheduler)", () => {
  it("expires lapsed offers and reservations and takes down non-compliant listings in one idempotent pass, per tenant", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    // 1. a published listing whose permit later lapses (unit A)
    const lic = await makeVerifiedLicences(t, k.agent.id);
    const listing = await createListing(sq(), t.admin, { unitId: k.inv.unit.id, purpose: "sale", title: "T", description: "D", price: 2_000_000, agentUserId: k.agent.id, brokerLicenceId: lic.company.id });
    for (let i = 0; i < 3; i++) await addListingMedia(sq(), t.admin, listing.id, { kind: "image", storageKey: `k/${i}.jpg` });
    const permit = await addPermit(sq(), t.admin, listing.id, { permitNo: uniq("TRK"), authority: "DLD_TRAKHEESI", expiresAt: dateOffset(30) });
    await verifyPermit(sq(), t.admin, permit.id, "valid");
    await publishListing(sq(), t.admin, listing.id);
    await sq().query("UPDATE listing_permits SET expires_at=:d WHERE id=:id", { replacements: { d: dateOffset(-1), id: permit.id } });

    // 2. an open offer that lapsed, and 3. a reservation whose hold elapsed (on another unit)
    const lapsed = await createOffer(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_000_000, validUntil: new Date(Date.now() + 3_600_000).toISOString() });
    await sq().query("UPDATE offers SET valid_until = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: lapsed.id } });
    const inv2 = await (await import("./brokerage-helpers")).makeInventory(t);
    const k2 = { ...k, inv: inv2 };
    const offer2 = await acceptedOffer(t, k2);
    const res = await createReservation(sq(), k.mgr.ctx, { unitId: inv2.unit.id, contactId: k.contact.id, offerId: offer2.id, holdHours: 1 });
    await sq().query("UPDATE reservations SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: res.id } });

    const other = await makeTenant(); // a second tenant must be swept independently and stay untouched
    const results = await runSweeps(sq());
    const mine = results.find((r) => r.tenantId === t.tenantId)!;
    expect(mine).toMatchObject({ offersExpired: 1, reservationsExpired: 1, listingsUnpublished: 1 });
    expect(results.find((r) => r.tenantId === other.tenantId)).toMatchObject({ offersExpired: 0, reservationsExpired: 0, listingsUnpublished: 0 });
    expect(results.every((r) => !r.error)).toBe(true);

    const status = async (table: string, id: string) => (await sq().query<{ status: string }>(`SELECT status FROM ${table} WHERE id=:id`, { replacements: { id }, type: QueryTypes.SELECT }))[0]!.status;
    expect(await status("offers", lapsed.id)).toBe("expired");
    expect(await status("reservations", res.id)).toBe("expired");
    expect(await status("units", inv2.unit.id)).toBe("available");
    expect(await status("listings", listing.id)).toBe("unpublished");

    const second = (await runSweeps(sq())).find((r) => r.tenantId === t.tenantId)!;
    expect(second).toMatchObject({ offersExpired: 0, reservationsExpired: 0, listingsUnpublished: 0 }); // idempotent
    const audit = await sq().query<{ actor_id: string }>("SELECT actor_id FROM audit_events WHERE tenant_id=:t AND action IN ('reservation.expired','listing.unpublished')", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.every((a) => a.actor_id === "system")).toBe(true);
  });
});
