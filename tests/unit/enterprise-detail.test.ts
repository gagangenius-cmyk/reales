import { describe, expect, it } from "vitest";
import { holdsAtLeast, PERMISSIONS, ROLE_TEMPLATES } from "@reales/rbac";
import { applySlab, normalizeLeadPayload, fromDubai, periodBounds, permissionCatalogue, toDubai, toMin, validateSlabs } from "@reales/domain";
import {
  agentProfileSchema, commissionPaySchema, commissionPlanSchema, createRoleSchema, leadSchema, setRoleGrantsSchema, timeOffSchema, updateContactSchema, updateLeadSchema, weeklyAvailabilitySchema,
} from "@reales/validation";

const uuid = "11111111-1111-4111-8111-111111111111";

describe("permission catalogue (roles screen)", () => {
  it("lists every permission exactly once, grouped by module", () => {
    const all = permissionCatalogue().flatMap((m) => m.permissions.map((p) => p.key));
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(Object.keys(PERMISSIONS).sort());
    for (const m of permissionCatalogue()) for (const p of m.permissions) expect(p.key.startsWith(`${m.module}.`)).toBe(true);
  });
  it("only seeds role templates with known permissions and valid scopes", () => {
    const scopes = new Set(["tenant", "business_unit", "branch", "project", "portfolio", "own_records"]);
    for (const t of ROLE_TEMPLATES) for (const [perm, scope] of t.grants) { expect(perm in PERMISSIONS).toBe(true); expect(scopes.has(scope)).toBe(true); }
  });
  it("rejects an unknown scope and accepts a valid matrix", () => {
    expect(setRoleGrantsSchema.safeParse({ grants: [{ permission: "lead.read", scope: "galaxy" }] }).success).toBe(false);
    expect(setRoleGrantsSchema.safeParse({ grants: [{ permission: "lead.read", scope: "branch" }] }).success).toBe(true);
    expect(createRoleSchema.safeParse({ name: "Senior Agent", grants: [] }).success).toBe(true);
    expect(createRoleSchema.safeParse({ name: "x" }).success).toBe(false);
  });
});

describe("Dubai time maths (agent availability)", () => {
  it("converts Dubai wall-clock to UTC with no daylight saving", () => {
    expect(fromDubai("2026-11-02", 9 * 60).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(fromDubai("2026-07-02", 0).toISOString()).toBe("2026-07-01T20:00:00.000Z");
  });
  it("reads UTC instants back as Dubai wall-clock", () => {
    const d = toDubai(new Date("2026-11-02T21:30:00Z")); // 01:30 next day in Dubai
    expect(d.getUTCDate()).toBe(3);
    expect(d.getUTCHours() * 60 + d.getUTCMinutes()).toBe(90);
  });
  it("parses HH:mm", () => expect(toMin("09:30")).toBe(570));
  it("validates windows and time off payloads", () => {
    expect(weeklyAvailabilitySchema.safeParse({ windows: [{ weekday: 1, startTime: "09:00", endTime: "18:00" }] }).success).toBe(true);
    expect(weeklyAvailabilitySchema.safeParse({ windows: [{ weekday: 7, startTime: "09:00", endTime: "18:00" }] }).success).toBe(false);
    expect(weeklyAvailabilitySchema.safeParse({ windows: [{ weekday: 1, startTime: "9:00", endTime: "18:00" }] }).success).toBe(false);
    expect(timeOffSchema.safeParse({ startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-05T00:00:00Z", reason: "Leave" }).success).toBe(true);
  });
});

describe("lead and contact detail capture", () => {
  it("accepts the full enquiry profile and rejects bad values", () => {
    const ok = leadSchema.safeParse({
      contact: { firstName: "Aisha", phone: "0501234567", salutation: "Ms", gender: "female", residency: "uae_resident", preferredChannel: "whatsapp", tags: ["investor"] },
      purpose: "buy", sourceCode: "walk_in", isHot: true, campaign: "Instagram Ramadan", financing: "mortgage", purchaseTimeline: "one_to_three_months",
      propertyTypes: ["apartment"], tags: ["golden-visa"], notes: "Prefers sea view", nextFollowUpAt: "2026-11-05T09:00:00.000Z", expectedCloseDate: "2026-12-31", stageId: uuid, assignedUserId: uuid,
    });
    expect(ok.success).toBe(true);
    expect(leadSchema.safeParse({ contactId: uuid, purpose: "buy", budgetMin: 5, budgetMax: 1 }).success).toBe(false);
    expect(leadSchema.safeParse({ contactId: uuid, purpose: "buy", financing: "barter" }).success).toBe(false);
    expect(leadSchema.safeParse({ contactId: uuid, purpose: "buy", expectedCloseDate: "tomorrow" }).success).toBe(false);
    expect(updateLeadSchema.safeParse({ isHot: false, tags: [] }).success).toBe(true);
  });
  it("lets an update clear optional contact fields with null but not the phone with garbage", () => {
    expect(updateContactSchema.safeParse({ jobTitle: null, notes: null, gender: null }).success).toBe(true);
    expect(updateContactSchema.safeParse({ gender: "robot" }).success).toBe(false);
    expect(updateContactSchema.safeParse({ dateOfBirth: "01/02/1990" }).success).toBe(false);
  });
});

describe("agents and commissions", () => {
  it("validates internal/external agent profiles", () => {
    expect(agentProfileSchema.safeParse({ userId: uuid, agentType: "external", agencyName: "Partner Realty", brn: "12345" }).success).toBe(true);
    expect(agentProfileSchema.safeParse({ userId: uuid, agentType: "contractor" }).success).toBe(false);
  });
  it("validates a plan targeted at an agent type with VAT", () => {
    expect(commissionPlanSchema.safeParse({ name: "External sales", dealType: "sale", agentType: "external", ratePct: 2, vatPct: 5, splits: [{ role: "agent", pct: 60 }, { role: "company", pct: 40 }] }).success).toBe(true);
    expect(commissionPlanSchema.safeParse({ name: "x", dealType: "sale", agentType: "freelance", ratePct: 2, splits: [{ role: "agent", pct: 100 }] }).success).toBe(false);
    expect(commissionPaySchema.safeParse({ reference: "" }).success).toBe(false);
  });
});

describe("role escalation guard", () => {
  const ctx = (...grants: [string, string][]) => ({ grants: grants.map(([permission, scope]) => ({ permission, scope })) }) as never;
  it("only lets you hand out a permission at a scope you hold or a narrower one", () => {
    expect(holdsAtLeast(ctx(["lead.read", "tenant"]), "lead.read", "branch")).toBe(true);
    expect(holdsAtLeast(ctx(["lead.read", "branch"]), "lead.read", "own_records")).toBe(true);
    expect(holdsAtLeast(ctx(["lead.read", "branch"]), "lead.read", "tenant")).toBe(false);
    expect(holdsAtLeast(ctx(["lead.read", "own_records"]), "lead.read", "branch")).toBe(false);
    expect(holdsAtLeast(ctx(["lead.read", "project"]), "lead.read", "branch")).toBe(false);
    expect(holdsAtLeast(ctx(["lead.read", "tenant"]), "deal.read", "own_records")).toBe(false);
  });
});

describe("commission slabs (pure)", () => {
  const splits = [{ role: "agent", pct: 50 }, { role: "brokerage", pct: 30 }, { role: "introducer", pct: 20 }];
  const slabs = [{ fromValue: 0, agentSharePct: 50 }, { fromValue: 1_000_000, agentSharePct: 60 }, { fromValue: 3_000_000, ratePct: 3, agentSharePct: 70 }];
  it("picks the slab reached before the deal and keeps the split at exactly 100%", () => {
    for (const [ytd, rate, agent] of [[0, 2, 50], [999_999, 2, 50], [1_000_000, 2, 60], [2_999_999, 2, 60], [3_000_000, 3, 70], [9e9, 3, 70]] as const) {
      const r = applySlab(2, splits, slabs, ytd);
      expect(r.ratePct).toBe(rate);
      expect(r.splits.find((s) => s.role === "agent")!.pct).toBe(agent);
      expect(Math.round(r.splits.reduce((a, s) => a + s.pct, 0) * 1000) / 1000).toBe(100);
    }
  });
  it("scales the other recipients in proportion", () => {
    const r = applySlab(2, splits, slabs, 1_500_000); // agent 60 -> others share 40 as 30:20
    expect(r.splits.find((s) => s.role === "brokerage")!.pct).toBe(24);
    expect(r.splits.find((s) => s.role === "introducer")!.pct).toBe(16);
  });
  it("adds a company line when the plan only had an agent, and is a no-op without slabs", () => {
    const r = applySlab(2, [{ role: "agent", pct: 100 }], [{ fromValue: 0, agentSharePct: 80 }], 0);
    expect(r.splits).toEqual([{ role: "agent", pct: 80 }, { role: "company", pct: 20 }]);
    expect(applySlab(2.5, splits, [], 5e6)).toMatchObject({ ratePct: 2.5, slab: null });
  });
  it("validates slab definitions", () => {
    expect(() => validateSlabs([{ fromValue: 10, ratePct: 3 }])).toThrow(/start at 0/);
    expect(() => validateSlabs([{ fromValue: 0, ratePct: 3 }, { fromValue: 0, ratePct: 4 }])).toThrow(/same value/);
    expect(() => validateSlabs([{ fromValue: 0 }])).toThrow(/rate, the agent/);
    expect(() => validateSlabs([{ fromValue: 0, agentSharePct: 120 }])).toThrow(/between 0 and 100/);
    expect(validateSlabs([{ fromValue: 5, ratePct: 3 }, { fromValue: 0, ratePct: 2 }]).map((s) => s.fromValue)).toEqual([0, 5]);
  });
});

describe("target periods", () => {
  it("finds the month, quarter and year containing a date", () => {
    expect(periodBounds("month", "2026-10-19")).toEqual({ start: "2026-10-01", end: "2026-11-01" });
    expect(periodBounds("quarter", "2026-11-30")).toEqual({ start: "2026-10-01", end: "2027-01-01" });
    expect(periodBounds("year", "2026-02-02")).toEqual({ start: "2026-01-01", end: "2027-01-01" });
    expect(periodBounds("month", "2026-12-31")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });
});

describe("inbound lead payloads", () => {
  it("maps flat JSON, Meta field_data and batches, and keeps unknown fields in the notes", () => {
    const [flat] = normalizeLeadPayload({ id: 7, name: "Sara Ali", Email: "x", email: "sara@example.com", mobile: "050 123 4567", looking_to: "Rent", budget: "AED 150,000", message: "2BR please", floor: "high" });
    expect(flat).toMatchObject({ externalId: "7", firstName: "Sara", lastName: "Ali", email: "sara@example.com", phone: "050 123 4567", purpose: "rent", budgetMax: 150000 });
    expect(flat!.notes).toContain("2BR please");
    expect(flat!.notes).toContain("floor: high");
    const meta = normalizeLeadPayload({ entry: [{ changes: [{ value: { leadgen_id: "A", field_data: [{ name: "full_name", values: ["Omar Khan"] }, { name: "phone_number", values: ["+971501234567"] }] } }] }] });
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ externalId: "A", firstName: "Omar", lastName: "Khan", phone: "+971501234567" });
    expect(normalizeLeadPayload({ leads: [{ email: "a@b.co" }, { email: "c@d.co" }] })).toHaveLength(2);
    expect(normalizeLeadPayload("nonsense")).toEqual([]);
    // without an id the dedupe key is stable for identical content and differs for different people
    const a = normalizeLeadPayload({ email: "p@q.com", name: "P" })[0]!.externalId, b = normalizeLeadPayload({ email: "p@q.com", name: "P" })[0]!.externalId, c = normalizeLeadPayload({ email: "z@q.com", name: "Z" })[0]!.externalId;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("S3 request signing", () => {
  it("matches AWS's published Signature Version 4 example (GET Object with a Range header)", async () => {
    const { signAwsV4 } = await import("@reales/domain");
    const r = signAwsV4({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { range: "bytes=0-9" },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", amzDate: "20130524T000000Z",
    });
    expect(r.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(r.headers.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date");
  });
});
