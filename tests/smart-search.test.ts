import { afterAll, describe, expect, it } from "vitest";
import { askAssistant, createListingFromProperty, listingParams, parseMoney, smartListingQuery } from "@reales/domain";
import { closeTestDb, makeTenant, testDb } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);

describe("plain-words listing search", () => {
  it("reads money in the ways people write it", () => {
    expect(parseMoney("2m")).toBe(2_000_000);
    expect(parseMoney("1.5 million")).toBe(1_500_000);
    expect(parseMoney("150k")).toBe(150_000);
    expect(parseMoney("AED 2,500,000")).toBe(2_500_000);
    expect(parseMoney("banana")).toBeNull();
    expect(parseMoney("0")).toBeNull();
  });

  it("turns a sentence into the Listings filters and says what it understood", async () => {
    const t = await makeTenant();
    const a = await smartListingQuery(sq(), t.admin, "Show me 2 bed apartments in Dubai Marina under 2m");
    expect(a.filters).toMatchObject({ bedsMin: 2, bedsMax: 2, types: ["apartment"], maxPrice: 2_000_000, community: "Dubai Marina" });
    expect(a.understood).toEqual(expect.arrayContaining(["2 bedrooms", "apartment", "in Dubai Marina"]));
    const b = await smartListingQuery(sq(), t.admin, "furnished studio for rent below 80k");
    expect(b.filters).toMatchObject({ purpose: "rent", furnishing: "furnished", types: ["studio"], bedsMin: 0, bedsMax: 0, maxPrice: 80_000 });
    const c = await smartListingQuery(sq(), t.admin, "villas between 3m and 6m for sale in Arabian Ranches");
    expect(c.filters).toMatchObject({ types: ["villa"], minPrice: 3_000_000, maxPrice: 6_000_000, purpose: "sale", community: "Arabian Ranches" });
    const d = await smartListingQuery(sq(), t.admin, "3+ bedroom townhouse over 2.5m");
    expect(d.filters).toMatchObject({ bedsMin: 3, types: ["townhouse"], minPrice: 2_500_000 });
    expect(d.filters.bedsMax).toBeUndefined();
    const e = await smartListingQuery(sq(), t.admin, "sea view penthouse");
    expect(e.filters.types).toEqual(["penthouse"]);
    expect(e.filters.q).toBe("sea view"); // words it does not know stay as a text search
    expect(listingParams(a.filters)).toMatchObject({ type: "apartment", bedsMin: "2", maxPrice: "2000000", community: "Dubai Marina" });
    expect((await smartListingQuery(sq(), t.admin, "")).understood).toEqual([]);
  });

  it("is used by the assistant and returns only matching listings", async () => {
    const t = await makeTenant();
    const mk = (n: string, o: Record<string, unknown>) => createListingFromProperty(sq(), t.admin, { emirate: "Dubai", community: "Dubai Marina", buildingName: "Smart Tower", unitNumber: n, type: "apartment", purpose: "sale", price: 1_500_000, bedrooms: 2, bathrooms: 2, builtUpAreaSqft: 1000, ...o } as never);
    await mk("1", {});
    await mk("2", { price: 3_500_000 });
    await mk("3", { bedrooms: 3 });
    const r = await askAssistant(sq(), t.admin, "show 2 bed apartments in dubai marina under 2m");
    expect(r.answer).toMatch(/^1 listings: /);
    expect(r.link?.href).toContain("maxPrice=2000000");
    expect(r.items).toHaveLength(1);
    expect((await askAssistant(sq(), t.admin, "3 bed apartment")).answer).toMatch(/^1 listings/);
    expect((await askAssistant(sq(), t.admin, "villa for rent")).answer).toMatch(/^No listings/);
  });
});

describe("lead summary", () => {
  it("describes a lead from recorded facts only", async () => {
    const { createLead, logCall, summarizeLead } = await import("@reales/domain");
    const { phone } = await import("./deal-helpers");
    const t = await makeTenant();
    const lead: any = await createLead(sq(), t.admin, { contact: { firstName: "Sara", lastName: "Khan", phone: phone() }, purpose: "buy", sourceCode: "walk_in", bedrooms: 2, budgetMin: 1_000_000, budgetMax: 1_500_000 } as never);
    const before = await summarizeLead(sq(), t.admin, lead.lead.id);
    expect(before.headline).toContain("Sara Khan");
    expect(before.paragraphs.join(" ")).toMatch(/Nobody has contacted this lead yet/);
    expect(before.paragraphs.join(" ")).toMatch(/2 bedrooms/);
    expect(before.paragraphs.join(" ")).toMatch(/1,000,000 to 1,500,000/);
    await logCall(sq(), t.admin, { leadId: lead.lead.id, outcome: "answered", durationSec: 90 });
    const after = await summarizeLead(sq(), t.admin, lead.lead.id);
    expect(after.paragraphs.join(" ")).toMatch(/1 call \(1 answered, 0 unanswered\)/);
    expect(after.paragraphs.join(" ")).not.toMatch(/Nobody has contacted/);
  });
});

describe("optional AI wording of the lead summary", () => {
  const facts = ["Sara Khan came in 3 days ago from Bayut and is an open lead.", "Looking to buy, 2 bedrooms, budget AED 1,000,000 to 1,500,000."];
  const reply = (text: string) => (async () => ({ ok: true, json: async () => ({ content: [{ text }] }) })) as unknown as typeof fetch;
  it("stays off unless explicitly enabled, never sends the name, and rejects replies that add numbers", async () => {
    const { polishSummary } = await import("@reales/domain");
    const old = { k: process.env.ANTHROPIC_API_KEY, f: process.env.LEAD_SUMMARY_AI };
    try {
      process.env.ANTHROPIC_API_KEY = "k"; delete process.env.LEAD_SUMMARY_AI;
      expect(await polishSummary(facts, "Sara Khan", reply("x"))).toBeNull(); // key alone is not enough
      process.env.LEAD_SUMMARY_AI = "1";
      let sent = "";
      const spy = (async (_u: string, init: any) => { sent = init.body; return { ok: true, json: async () => ({ content: [{ text: "the lead is a 2 bedroom buyer from Bayul with AED 1,000,000 to 1,500,000." }] }) }; }) as unknown as typeof fetch;
      expect(await polishSummary(facts, "Sara Khan", spy)).toContain("Sara Khan is a 2 bedroom buyer");
      expect(sent).not.toContain("Sara");
      expect(await polishSummary(facts, "Sara Khan", reply("The lead has a 3 bedroom wish and AED 2,000,000."))).toBeNull(); // 3 bedroom? 3 is in facts, 2,000,000 is not
      expect(await polishSummary(facts, "Sara Khan", (async () => ({ ok: false })) as unknown as typeof fetch)).toBeNull();
    } finally { if (old.k === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = old.k; if (old.f === undefined) delete process.env.LEAD_SUMMARY_AI; else process.env.LEAD_SUMMARY_AI = old.f; }
  });
});
