import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";

/**
 * Jurisdiction-specific listing publication requirements are DATA (versioned rows), never conditionals in UI code.
 * The seeded contents below are ILLUSTRATIVE DEFAULTS that must be reviewed by a UAE real-estate compliance specialist
 * before any customer relies on them (the blueprint is explicit that this role is not optional).
 */
export interface ListingPublicationRule {
  requiredListingFields: string[];
  requiredUnitFields: string[];
  minImages: number;
  permit: { required: boolean; authorities: string[] };
  brokerLicence: { required: boolean; authorities: string[] };
  agentLicence: { required: boolean; authorities: string[] };
  offPlan: { requireRegistrationNo: boolean; requireEscrowRef: boolean };
  unitMustBeAvailable: boolean;
}

export const LISTING_RULE_CODE = "listing.publication";

const base: ListingPublicationRule = {
  requiredListingFields: ["title", "description", "price", "agentUserId"],
  requiredUnitFields: ["areaSqft", "type"],
  minImages: 3,
  permit: { required: true, authorities: [] },
  brokerLicence: { required: true, authorities: [] },
  agentLicence: { required: true, authorities: [] },
  offPlan: { requireRegistrationNo: true, requireEscrowRef: true },
  unitMustBeAvailable: true,
};

export const JURISDICTIONS = [
  { code: "DUBAI_MAINLAND", name: "Dubai (mainland)", emirate: "DUBAI", registrationAuthority: "DLD", tenancyAuthority: "RERA_DLD",
    rule: { ...base, permit: { required: true, authorities: ["DLD_TRAKHEESI"] }, brokerLicence: { required: true, authorities: ["DLD_RERA"] }, agentLicence: { required: true, authorities: ["DLD_RERA"] } } },
  { code: "ABU_DHABI_MAINLAND", name: "Abu Dhabi (mainland)", emirate: "ABU_DHABI", registrationAuthority: "ADREC", tenancyAuthority: "ADREC",
    rule: { ...base, permit: { required: true, authorities: ["ADREC"] }, brokerLicence: { required: true, authorities: ["ADREC"] }, agentLicence: { required: true, authorities: ["ADREC"] } } },
  { code: "ADGM", name: "Abu Dhabi Global Market", emirate: "ABU_DHABI", registrationAuthority: "ADGM_RA", tenancyAuthority: null,
    rule: { ...base, permit: { required: false, authorities: [] }, brokerLicence: { required: true, authorities: ["ADGM_RA"] }, agentLicence: { required: false, authorities: [] }, offPlan: { requireRegistrationNo: true, requireEscrowRef: false } } },
] as const;

/** Global, platform-maintained. Idempotent; a changed definition becomes a NEW version instead of editing history. */
export async function seedRegulatory(sq: Sequelize) {
  for (const j of JURISDICTIONS) {
    await sq.query(
      "INSERT INTO jurisdictions (id, code, name, emirate, registration_authority, tenancy_authority, created_at, updated_at) VALUES (UUID(), :code, :name, :emirate, :ra, :ta, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE name=VALUES(name)",
      { replacements: { code: j.code, name: j.name, emirate: j.emirate, ra: j.registrationAuthority, ta: j.tenancyAuthority } },
    );
    const [jur] = await sq.query<{ id: string }>("SELECT id FROM jurisdictions WHERE code=:c", { replacements: { c: j.code }, type: QueryTypes.SELECT });
    await sq.query(
      "INSERT INTO regulatory_rules (id, jurisdiction_id, code, description, created_at, updated_at) VALUES (UUID(), :j, :code, 'Illustrative listing publication requirements - requires compliance review', NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE description=description",
      { replacements: { j: jur!.id, code: LISTING_RULE_CODE } },
    );
    const [rule] = await sq.query<{ id: string }>("SELECT id FROM regulatory_rules WHERE jurisdiction_id=:j AND code=:c", { replacements: { j: jur!.id, c: LISTING_RULE_CODE }, type: QueryTypes.SELECT });
    const [latest] = await sq.query<{ version: number; definition: any }>("SELECT version, definition FROM regulatory_rule_versions WHERE rule_id=:r ORDER BY version DESC LIMIT 1", { replacements: { r: rule!.id }, type: QueryTypes.SELECT });
    const current = latest ? (typeof latest.definition === "string" ? JSON.parse(latest.definition) : latest.definition) : null;
    if (!current || JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(j.rule))) {
      await sq.query(
        "INSERT INTO regulatory_rule_versions (id, rule_id, version, effective_from, definition, created_at, updated_at) VALUES (:id, :r, :v, CURDATE(), :def, NOW(3), NOW(3))",
        { replacements: { id: randomUUID(), r: rule!.id, v: (latest?.version ?? 0) + 1, def: JSON.stringify(j.rule) } },
      );
      if (latest) await sq.query("UPDATE regulatory_rule_versions SET effective_to = CURDATE() WHERE rule_id=:r AND version=:v AND effective_to IS NULL", { replacements: { r: rule!.id, v: latest.version } });
    }
  }
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export interface ResolvedRule { jurisdictionCode: string; ruleVersion: number; definition: ListingPublicationRule }

/** The rule version in force on `date` for a jurisdiction. Returns null for an unknown jurisdiction (callers must block, not guess). */
export async function resolveListingRule(sq: Sequelize, jurisdictionCode: string, date = new Date()): Promise<ResolvedRule | null> {
  const day = date.toISOString().slice(0, 10);
  const [row] = await sq.query<{ version: number; definition: any }>(
    `SELECT v.version, v.definition FROM regulatory_rule_versions v
       JOIN regulatory_rules r ON r.id = v.rule_id JOIN jurisdictions j ON j.id = r.jurisdiction_id
      WHERE j.code=:code AND r.code=:rc AND v.effective_from <= :day AND (v.effective_to IS NULL OR v.effective_to >= :day)
      ORDER BY v.version DESC LIMIT 1`,
    { replacements: { code: jurisdictionCode, rc: LISTING_RULE_CODE, day }, type: QueryTypes.SELECT },
  );
  if (!row) return null;
  return { jurisdictionCode, ruleVersion: row.version, definition: typeof row.definition === "string" ? JSON.parse(row.definition) : row.definition };
}
