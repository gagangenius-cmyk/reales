import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { GLOBAL_TABLES, TENANT_OWNED_TABLES } from "@reales/database";
import { closeTestDb, testDb } from "../helpers";

afterAll(closeTestDb);

/**
 * Release-blocking guard: any table that carries tenant_id must be registered as tenant-owned
 * and be indexed with tenant_id leading; any new table must be classified. Forgetting to register a
 * new table fails CI instead of silently shipping an unscoped table.
 */
describe("tenant isolation: schema guard", () => {
  it("classifies every table as tenant-owned or global", async () => {
    const rows = await testDb().query<{ t: string }>("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()", { type: QueryTypes.SELECT });
    const all = rows.map((r) => r.t);
    const known = new Set<string>([...TENANT_OWNED_TABLES, ...GLOBAL_TABLES]);
    expect(all.filter((t) => !known.has(t))).toEqual([]);
  });

  it("tenant_id column exists on exactly the tenant-owned tables", async () => {
    const rows = await testDb().query<{ t: string }>(
      "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id'", { type: QueryTypes.SELECT });
    expect(rows.map((r) => r.t).sort()).toEqual([...TENANT_OWNED_TABLES].sort());
  });

  it("every tenant-owned table has an index that starts with tenant_id", async () => {
    const rows = await testDb().query<{ t: string }>(
      "SELECT DISTINCT TABLE_NAME AS t FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' AND SEQ_IN_INDEX = 1", { type: QueryTypes.SELECT });
    const indexed = new Set(rows.map((r) => r.t));
    // outbox_events is dispatched globally by (status, next_attempt_at) but also carries (tenant_id, type, occurred_at)
    expect([...TENANT_OWNED_TABLES].filter((t) => !indexed.has(t))).toEqual([]);
  });

  it("no globally-unique email or slug-like index exists on tenant data", async () => {
    const rows = await testDb().query<{ t: string; idx: string; cols: string }>(
      `SELECT TABLE_NAME AS t, INDEX_NAME AS idx, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0 GROUP BY TABLE_NAME, INDEX_NAME`, { type: QueryTypes.SELECT });
    const tenantOwned = new Set<string>(TENANT_OWNED_TABLES);
    // webhook_events dedupes raw provider event ids globally BEFORE the tenant is known (tenant_id is resolved during processing);
    // events only enter after signature verification, so a tenant cannot squat another tenant's event ids.
    // sso_states is looked up by the hash of a 192-bit random OIDC state in the IdP callback, before the tenant is known; the state is single-use and short-lived. auth_tokens is looked up by the hash of the emailed one-time token (256-bit random) before the tenant is known.
    // lead_ingest_sources is looked up by its 120-bit random public id in the inbound-lead URL before the tenant is known; every request is then verified against that source's own HMAC secret.
    const GLOBAL_BY_DESIGN = new Set(["webhook_events", "sso_states", "auth_tokens", "lead_ingest_sources"]);
    const offenders = rows.filter((r) => tenantOwned.has(r.t) && !GLOBAL_BY_DESIGN.has(r.t) && r.idx !== "PRIMARY" && !r.cols.split(",").includes("tenant_id") && !["role_id"].includes(r.cols.split(",")[0]!));
    expect(offenders).toEqual([]);
  });
});
