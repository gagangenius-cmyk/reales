import { describe, expect, it } from "vitest";
import { holdsAtLeast, PERMISSIONS, ROLE_TEMPLATES } from "@reales/rbac";
import { fromDubai, permissionCatalogue, toDubai, toMin } from "@reales/domain";
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
