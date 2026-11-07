import { describe, expect, it } from "vitest";
import { isManagerView } from "@reales/domain";

const ctx = (...grants: [string, string][]) => ({ grants: grants.map(([permission, scope]) => ({ permission, scope })), userId: "u", membership: { businessUnitIds: [], branchIds: [], projectIds: [], portfolioIds: [] } }) as never;

describe("which dashboard a person gets", () => {
  it("gives agents (own records only) the personal view", () => {
    expect(isManagerView(ctx(["lead.read", "own_records"], ["lead.update", "own_records"]))).toBe(false);
  });
  it("gives anyone who sees a branch, business unit or the company the team view", () => {
    expect(isManagerView(ctx(["lead.read", "branch"]))).toBe(true);
    expect(isManagerView(ctx(["lead.read", "business_unit"]))).toBe(true);
    expect(isManagerView(ctx(["lead.read", "tenant"]))).toBe(true);
  });
  it("gives people who can assign leads the team view even with narrow read access", () => {
    expect(isManagerView(ctx(["lead.read", "own_records"], ["lead.assign", "own_records"]))).toBe(true);
  });
  it("gives people with no lead access the personal view", () => {
    expect(isManagerView(ctx(["project.read", "tenant"]))).toBe(false);
  });
});
