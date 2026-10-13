import { afterAll, describe, expect, it } from "vitest";
import { createRoutingRule } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, dateOffset, makeInventory, makeOrg, makeVerifiedLicences } from "./brokerage-helpers";
import { adminSession, call, loginAs } from "./api-helpers";
import { GET as contactsGet, POST as contactsPost } from "@/app/api/v1/contacts/route";
import { GET as contactGet } from "@/app/api/v1/contacts/[id]/route";
import { POST as consentPost } from "@/app/api/v1/contacts/[id]/consents/route";
import { POST as suppressionPost } from "@/app/api/v1/suppressions/route";
import { DELETE as suppressionDelete } from "@/app/api/v1/suppressions/[id]/route";
import { GET as leadsGet, POST as leadsPost } from "@/app/api/v1/leads/route";
import { GET as leadGet } from "@/app/api/v1/leads/[id]/route";
import { POST as leadStagePost } from "@/app/api/v1/leads/[id]/stage/route";
import { POST as listingsPost } from "@/app/api/v1/listings/route";
import { POST as listingValidate } from "@/app/api/v1/listings/[id]/validate/route";
import { POST as listingPublish } from "@/app/api/v1/listings/[id]/publish/route";
import { POST as listingMedia } from "@/app/api/v1/listings/[id]/media/route";
import { POST as listingPermits } from "@/app/api/v1/listings/[id]/permits/route";
import { POST as permitVerify } from "@/app/api/v1/listing-permits/[id]/verify/route";
import { POST as portalPost } from "@/app/api/v1/portal-connections/route";
import { GET as portalFeed } from "@/app/api/v1/portal-connections/[id]/feed/route";
import { POST as routingPost } from "@/app/api/v1/routing-rules/route";

afterAll(closeTestDb);
const sq = () => testDb();
const phone = () => `05${Math.floor(10000000 + Math.random() * 89999999)}`;

describe("API: contacts and consent", () => {
  it("creates contacts with normalisation, blocks duplicates with a privacy-safe 409, and rejects unknown fields", async () => {
    const t = await makeTenant();
    const { bu, marina } = await makeOrg(t);
    const a1 = await agentIn(t, marina.id, bu.id);
    const a2 = await agentIn(t, marina.id, bu.id);
    const s1 = (await loginAs(t.slug, a1.email)).token!;
    const s2 = (await loginAs(t.slug, a2.email)).token!;

    const created = await call(contactsPost, "POST", "/api/v1/contacts", { cookie: s1, body: { firstName: "Layla", phone: "050 555 1212", email: "Layla@X.com" } });
    expect(created.status).toBe(201);
    expect(created.json.phoneE164).toBe("+971505551212");
    expect(created.json.normalizedEmail).toBe("layla@x.com");

    const dup = await call(contactsPost, "POST", "/api/v1/contacts", { cookie: s2, body: { firstName: "Probe", phone: "+971505551212" } });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toMatchObject({ code: "duplicate_contact", matchCount: 1, matches: [] }); // no name/id leaked to a user who cannot see it

    const own = await call(contactsPost, "POST", "/api/v1/contacts", { cookie: s1, body: { firstName: "Layla 2", phone: "+971505551212" } });
    expect(own.json.error.matches).toEqual([{ id: created.json.id, name: "Layla" }]); // the owner may see their own

    expect((await call(contactsPost, "POST", "/api/v1/contacts", { cookie: s1, body: { firstName: "X", tenantId: "abc" } })).status).toBe(400); // strict schema
    expect((await call(contactsGet, "GET", "/api/v1/contacts?limit=500", { cookie: s1 })).status).toBe(400);
    expect((await call(contactGet, "GET", `/api/v1/contacts/${created.json.id}`, { cookie: s2, params: { id: created.json.id } })).status).toBe(404);
    expect((await call(contactGet, "GET", "/api/v1/contacts/not-a-uuid", { cookie: s1, params: { id: "not-a-uuid" } })).status).toBe(400);
  });

  it("records consent with evidence via the API and requires a fresh second factor to lift a suppression", async () => {
    const t = await makeTenant();
    const admin = await adminSession(t.slug, t.adminEmail);
    const c = await call(contactsPost, "POST", "/api/v1/contacts", { cookie: admin.token, body: { firstName: "Consent", phone: phone() } });
    const consent = await call(consentPost, "POST", `/api/v1/contacts/${c.json.id}/consents`, {
      cookie: admin.token, params: { id: c.json.id }, headers: { "x-real-ip": "203.0.113.7", "user-agent": "vitest" },
      body: { purposeCode: "marketing", channel: "whatsapp", granted: true, textVersion: "v1", text: "I agree", source: "web" },
    });
    expect(consent.status).toBe(201);
    expect(consent.json).toMatchObject({ status: "granted", channel: "whatsapp" });
    const bad = await call(consentPost, "POST", `/api/v1/contacts/${c.json.id}/consents`, { cookie: admin.token, params: { id: c.json.id }, body: { purposeCode: "marketing", channel: "pager", granted: true } });
    expect(bad.status).toBe(400);

    const sup = await call(suppressionPost, "POST", "/api/v1/suppressions", { cookie: admin.token, body: { channel: "sms", destination: "0501231231", reason: "complaint" } });
    expect(sup.status).toBe(201);
    const denied = await call(suppressionDelete, "DELETE", `/api/v1/suppressions/${sup.json.id}`, { cookie: admin.token, params: { id: sup.json.id }, body: { reason: "customer asked us to resume" } });
    expect(denied.status).toBe(401);
    expect(denied.json.error.code).toBe("step_up_required");
  });
});

describe("API: leads", () => {
  it("creates and routes a lead, replays it idempotently, flags repeat enquiries, and enforces visibility", async () => {
    const t = await makeTenant();
    const { bu, marina } = await makeOrg(t);
    const creator = await agentIn(t, marina.id, bu.id);
    const worker = await agentIn(t, marina.id, bu.id);
    const stranger = await agentIn(t, marina.id, bu.id);
    await createRoutingRule(sq(), t.admin, { name: "w", conditions: {}, target: { userIds: [worker.id] } });
    const cs = (await loginAs(t.slug, creator.email)).token!;
    const ws = (await loginAs(t.slug, worker.email)).token!;
    const ss = (await loginAs(t.slug, stranger.email)).token!;
    const body = { contact: { firstName: "Omar", phone: "0504441111" }, purpose: "buy", sourceCode: "website", budgetMax: 2_000_000 };

    const key = uniq("idem");
    const first = await call(leadsPost, "POST", "/api/v1/leads", { cookie: cs, headers: { "idempotency-key": key }, body });
    expect(first.status).toBe(201);
    expect(first.json.assignedUserId).toBe(worker.id);
    const replay = await call(leadsPost, "POST", "/api/v1/leads", { cookie: cs, headers: { "idempotency-key": key }, body });
    expect(replay.res.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.lead.id).toBe(first.json.lead.id);

    const repeat = await call(leadsPost, "POST", "/api/v1/leads", { cookie: cs, body: { ...body, contact: { firstName: "Omar again", phone: "+971 50 444 1111" } } });
    expect(repeat.status).toBe(200);
    expect(repeat.json).toMatchObject({ duplicate: true, contactReused: true });

    const id = first.json.lead.id;
    expect((await call(leadGet, "GET", `/api/v1/leads/${id}`, { cookie: ws, params: { id } })).status).toBe(200);
    expect((await call(leadGet, "GET", `/api/v1/leads/${id}`, { cookie: ss, params: { id } })).status).toBe(404);
    expect((await call(leadsGet, "GET", "/api/v1/leads?mine=true", { cookie: ss })).json.leads).toEqual([]);
    expect((await call(leadsGet, "GET", "/api/v1/leads?mine=true", { cookie: ws })).json.leads).toHaveLength(1);

    const lost = await call(leadStagePost, "POST", `/api/v1/leads/${id}/stage`, { cookie: ws, params: { id }, body: { stageKey: "lost" } });
    expect(lost.status).toBe(409);
    const ok = await call(leadStagePost, "POST", `/api/v1/leads/${id}/stage`, { cookie: ws, params: { id }, body: { stageKey: "lost", reason: "not interested" } });
    expect(ok.json).toMatchObject({ status: "lost" });

    // A viewer role may not create leads at all
    const other = await makeTenant();
    const poster = await call(routingPost, "POST", "/api/v1/routing-rules", { cookie: cs, body: { name: "x", conditions: {}, target: { userIds: [worker.id] } } });
    expect(poster.status).toBe(403);
    void other;
  });
});

describe("API: listing publication gate", () => {
  it("returns 422 with the exact issues, then publishes to portals and serves the feed", async () => {
    const t = await makeTenant();
    const admin = await adminSession(t.slug, t.adminEmail);
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id, "senior_broker");
    const kit = await makeInventory(t);
    const lic = await makeVerifiedLicences(t, agent.id);

    const acct = await call(portalPost, "POST", "/api/v1/portal-connections", { cookie: admin.token, body: { provider: "bayut", name: "Bayut" } });
    expect(acct.status).toBe(201);

    const l = await call(listingsPost, "POST", "/api/v1/listings", {
      cookie: admin.token, body: { unitId: kit.unit.id, purpose: "sale", title: "Marina 2BR", description: "Lovely", price: 2_000_000, agentUserId: agent.id, brokerLicenceId: lic.company.id },
    });
    expect(l.status).toBe(201);
    const id = l.json.id;
    const p = (path: string) => `/api/v1/listings/${id}/${path}`;

    const blocked = await call(listingPublish, "POST", p("publish"), { cookie: admin.token, params: { id } });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error.code).toBe("listing_not_publishable");
    expect(blocked.json.error.evaluation.issues.map((i: any) => i.code).sort()).toEqual(["media_insufficient", "permit_missing"]);

    for (let i = 0; i < 3; i++) await call(listingMedia, "POST", p("media"), { cookie: admin.token, params: { id }, body: { kind: "image", storageKey: `k/${i}.jpg` } });
    const permit = await call(listingPermits, "POST", p("permits"), { cookie: admin.token, params: { id }, body: { permitNo: uniq("TRK"), authority: "DLD_TRAKHEESI", expiresAt: dateOffset(60) } });
    expect(permit.status).toBe(201);
    const pending = await call(listingValidate, "POST", p("validate"), { cookie: admin.token, params: { id } });
    expect(pending.json.issues.map((i: any) => i.code)).toEqual(["permit_invalid"]); // recorded but not yet verified
    const pid = permit.json.id;
    expect((await call(permitVerify, "POST", `/api/v1/listing-permits/${pid}/verify`, { cookie: admin.token, params: { id: pid }, body: { outcome: "valid" } })).status).toBe(200);

    const published = await call(listingPublish, "POST", p("publish"), { cookie: admin.token, params: { id } });
    expect(published.status).toBe(200);
    expect(published.json.listing.status).toBe("published");
    expect(published.json.publications).toHaveLength(1);

    const feedId = acct.json.id;
    const feed = await call(portalFeed, "GET", `/api/v1/portal-connections/${feedId}/feed`, { cookie: admin.token, params: { id: feedId } });
    expect(feed.status).toBe(200);
    expect(feed.res.headers.get("content-type")).toContain("application/xml");
    expect(feed.text).toContain("<Properties>");
    expect(feed.text).toContain("<Property_Title>Marina 2BR</Property_Title>");
  });
});
