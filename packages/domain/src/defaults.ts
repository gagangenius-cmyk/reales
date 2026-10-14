import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { ensureDefaultConsentPurposes } from "./consent";

export const DEFAULT_STAGES = [
  { key: "new", name: "New", kind: "open", sla: 15 },
  { key: "contacted", name: "Contacted", kind: "open", sla: 240 },
  { key: "qualified", name: "Qualified", kind: "open", sla: null },
  { key: "viewing", name: "Viewing", kind: "open", sla: null },
  { key: "offer", name: "Offer", kind: "open", sla: null },
  { key: "won", name: "Won", kind: "won", sla: null },
  { key: "lost", name: "Lost", kind: "lost", sla: null },
] as const;

export const DEFAULT_SOURCES = [
  { code: "website", name: "Website form", kind: "form" },
  { code: "portal_bayut", name: "Bayut", kind: "portal" },
  { code: "portal_property_finder", name: "Property Finder", kind: "portal" },
  { code: "walk_in", name: "Walk-in", kind: "walk_in" },
  { code: "referral", name: "Referral", kind: "referral" },
  { code: "whatsapp", name: "WhatsApp", kind: "other" },
  { code: "call", name: "Inbound call", kind: "call" },
  { code: "api", name: "API", kind: "api" },
  { code: "import", name: "Data import", kind: "other" },
] as const;

/** Per-tenant defaults: consent purposes, lead sources and the default sales pipeline. Idempotent. */
export async function seedTenantDefaults(sq: Sequelize, tenantId: string) {
  await ensureDefaultConsentPurposes(sq, tenantId);
  for (const s of DEFAULT_SOURCES) {
    await sq.query(
      "INSERT INTO lead_sources (id, tenant_id, code, name, kind, created_at, updated_at) VALUES (UUID(), :t, :code, :name, :kind, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE name=VALUES(name)",
      { replacements: { t: tenantId, ...s } },
    );
  }
  const [existing] = await sq.query<{ id: string }>("SELECT id FROM pipelines WHERE tenant_id=:t AND is_default=1 LIMIT 1", { replacements: { t: tenantId }, type: QueryTypes.SELECT });
  if (existing) return;
  const pid = randomUUID();
  await sq.transaction(async (tx) => {
    await sq.query("INSERT INTO pipelines (id, tenant_id, name, is_default, created_at, updated_at) VALUES (:id, :t, 'Sales pipeline', 1, NOW(3), NOW(3))", { transaction: tx, replacements: { id: pid, t: tenantId } });
    let pos = 0;
    for (const st of DEFAULT_STAGES) {
      await sq.query(
        "INSERT INTO pipeline_stages (id, tenant_id, pipeline_id, `key`, name, position, kind, sla_minutes, created_at, updated_at) VALUES (UUID(), :t, :p, :key, :name, :pos, :kind, :sla, NOW(3), NOW(3))",
        { transaction: tx, replacements: { t: tenantId, p: pid, key: st.key, name: st.name, pos: pos++, kind: st.kind, sla: st.sla } },
      );
    }
  });
}
