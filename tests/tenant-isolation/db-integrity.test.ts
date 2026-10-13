import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createContact, createProject, createPipelineIds } from "./db-integrity.helpers";
import { closeTestDb, makeTenant, testDb } from "../helpers";

afterAll(closeTestDb);
const sq = () => testDb();

/**
 * Defence in depth: even if application code had a scoping bug, composite foreign keys (tenant_id, x_id) make the
 * database reject a row in tenant A that points at a record owned by tenant B.
 */
describe("tenant isolation: database-enforced referential integrity", () => {
  it("rejects a lead in tenant A that references tenant B's contact, and accepts the same-tenant reference", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const contactB = await createContact(b);
    const contactA = await createContact(a);
    const { pipelineId, stageId } = await createPipelineIds(a.tenantId);

    const insertLead = (tenantId: string, contactId: string) =>
      sq().query(
        `INSERT INTO leads (id, tenant_id, contact_id, pipeline_id, stage_id, status, purpose, currency, created_at, updated_at)
         VALUES (:id, :t, :c, :p, :s, 'open', 'buy', 'AED', NOW(3), NOW(3))`,
        { replacements: { id: randomUUID(), t: tenantId, c: contactId, p: pipelineId, s: stageId } },
      );
    await expect(insertLead(a.tenantId, contactB)).rejects.toThrow(/foreign key/i);
    await expect(insertLead(a.tenantId, contactA)).resolves.toBeTruthy();
  });

  it("rejects cross-tenant references from contacts, listings and portal publications", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const projB = await createProject(b);
    await expect(
      sq().query(
        "INSERT INTO pipelines (id, tenant_id, name, is_default, project_id, created_at, updated_at) VALUES (:id, :t, 'x', 0, :p, NOW(3), NOW(3))",
        { replacements: { id: randomUUID(), t: a.tenantId, p: projB } },
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      sq().query(
        "INSERT INTO contacts (id, tenant_id, type, owner_user_id, status, created_at, updated_at) VALUES (:id, :t, 'person', :u, 'active', NOW(3), NOW(3))",
        { replacements: { id: randomUUID(), t: a.tenantId, u: b.adminId } },
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("has composite tenant foreign keys on the core relationship columns", async () => {
    const rows = await sq().query<{ t: string; c: string }>(
      `SELECT k.TABLE_NAME t, k.COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL AND k.COLUMN_NAME <> 'tenant_id'
          AND EXISTS (SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k2 WHERE k2.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND k2.TABLE_SCHEMA = k.TABLE_SCHEMA AND k2.TABLE_NAME = k.TABLE_NAME AND k2.COLUMN_NAME = 'tenant_id')`,
      { type: QueryTypes.SELECT },
    );
    const have = new Set(rows.map((r) => `${r.t}.${r.c}`));
    for (const key of [
      "leads.contact_id", "leads.stage_id", "leads.assigned_user_id", "units.building_id", "buildings.re_project_id",
      "listings.unit_id", "listings.broker_licence_id", "listing_permits.listing_id", "portal_publications.listing_id",
      "consent_records.contact_id", "consent_events.consent_record_id", "pipeline_stages.pipeline_id", "tasks.lead_id",
    ]) expect(have, key).toContain(key);
  });
});
