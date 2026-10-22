import { afterAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createIngestSource, getLead, listIngestSources, receiveIngestedLeads, rotateIngestSecret, savePool, setIngestSourceActive, verifyIngestHandshake, WebhookSignatureError, createRoutingRule } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { kit, phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const sign = (secret: string, raw: string) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const send = (publicId: string, secret: string, body: unknown, bad = false) => {
  const rawBody = JSON.stringify(body);
  return receiveIngestedLeads(sq(), { publicId, rawBody, headers: { "x-signature": bad ? sign("wrong", rawBody) : sign(secret, rawBody) } });
};

describe("inbound lead sources", () => {
  it("creates, de-duplicates and rejects leads, keeps the secret hidden, and can route to a pool", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    await createRoutingRule(sq(), t.admin, { name: "all to agent", priority: 1, conditions: {}, target: { userIds: [k.agent.id] }, strategy: "round_robin" });
    const src = await createIngestSource(sq(), t.admin, { name: uniq("Bayut"), kind: "portal", sourceCode: "portal_bayut", defaultPurpose: "rent", campaign: "Bayut Q4" });
    expect(src.secret.length).toBeGreaterThan(20);
    const listed = await listIngestSources(sq(), t.admin);
    expect(JSON.stringify(listed)).not.toContain(src.secret); // never readable again
    await expect(createIngestSource(sq(), k.agent.ctx, { name: "x", kind: "generic" })).rejects.toThrow();

    const p = phone();
    const body = { id: "ext-1", full_name: "Sara Ali", email: `sara${Date.now()}@example.com`, phone: p, message: "Interested in 2BR", budget: "AED 150,000", unit_type: "apartment" };
    const r1 = await send(src.publicId, src.secret, body);
    expect(r1).toMatchObject({ received: 1, created: 1, duplicate: 0, rejected: 0 });
    // same delivery again (the sender retried): no second lead
    expect(await send(src.publicId, src.secret, body)).toMatchObject({ created: 0, duplicate: 1 });
    // same person under a new id: the existing open lead is updated, not duplicated
    expect(await send(src.publicId, src.secret, { ...body, id: "ext-2" })).toMatchObject({ created: 0, duplicate: 1 });
    const events = (await listIngestSources(sq(), t.admin)).events;
    const created = events.find((e: any) => e.status === "created")!;
    const lead = await getLead(sq(), t.admin, created.leadId);
    expect(lead).toMatchObject({ purpose: "rent", campaign: "Bayut Q4", assignedUserId: k.agent.id });
    expect(Number(lead.budgetMax)).toBe(150000);
    expect(lead.notes).toContain("Interested in 2BR");
    expect(lead.notes).toContain("unit_type: apartment");

    // authenticity: wrong signature, unknown source and a disabled source all look the same and store nothing
    await expect(send(src.publicId, src.secret, { ...body, id: "ext-3" }, true)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(send("nope", src.secret, body)).rejects.toBeInstanceOf(WebhookSignatureError);
    await setIngestSourceActive(sq(), t.admin, src.id, false);
    await expect(send(src.publicId, src.secret, { ...body, id: "ext-4" })).rejects.toBeInstanceOf(WebhookSignatureError);
    await setIngestSourceActive(sq(), t.admin, src.id, true);
    // rotating the secret locks out the old one
    const rotated = await rotateIngestSecret(sq(), t.admin, src.id);
    await expect(send(src.publicId, src.secret, { ...body, id: "ext-5" })).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(await send(src.publicId, rotated.secret, { name: "No Contact", id: "ext-6" })).toMatchObject({ created: 1 });
    // a lead with no way to reach anyone is rejected and recorded, not lost silently
    expect(await send(src.publicId, rotated.secret, { id: "ext-7", message: "hello" })).toMatchObject({ rejected: 1 });
    expect((await listIngestSources(sq(), t.admin)).events.find((e: any) => e.externalId === "ext-7")).toMatchObject({ status: "rejected" });
    // Meta handshake
    expect(await verifyIngestHandshake(sq(), src.publicId, rotated.secret)).toBe(true);
    expect(await verifyIngestHandshake(sq(), src.publicId, "guess")).toBe(false);

    // Meta-style batch routed to a pool instead of an agent
    const pool = await savePool(sq(), t.admin, { name: uniq("Meta pool") });
    const meta = await createIngestSource(sq(), t.admin, { name: uniq("Meta"), kind: "meta", routeMode: "pool", poolId: pool.id });
    const batch = { entry: [{ changes: [{ value: { leadgen_id: "L1", field_data: [{ name: "full_name", values: ["Omar Khan"] }, { name: "phone_number", values: [phone()] }] } }, { value: { leadgen_id: "L2", field_data: [{ name: "email", values: [`o${Date.now()}@example.com`] }] } }] }] };
    expect(await send(meta.publicId, meta.secret, batch)).toMatchObject({ received: 2, created: 2 });
    const metaLeads = (await listIngestSources(sq(), t.admin)).events.filter((e: any) => e.sourceId === meta.id && e.status === "created");
    for (const e of metaLeads) expect(await getLead(sq(), t.admin, e.leadId)).toMatchObject({ assignedUserId: null, poolId: pool.id });
  });
});
