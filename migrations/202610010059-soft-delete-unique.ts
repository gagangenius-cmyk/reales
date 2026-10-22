import { Ctx, step } from "./_helpers";

/**
 * Names that must be unique among LIVE rows only. A trashed template called "Welcome" must not block creating a new "Welcome", and restoring the old one
 * must fail clearly if the name has been taken. A STORED generated column is 1 for live rows and NULL for deleted ones; a unique index that ends with it
 * treats the NULLs as distinct, so deleted rows never collide.
 */
const INDEXES: { table: string; name: string; cols: string[] }[] = [
  { table: "bots", name: "uq_bots_name", cols: ["tenant_id", "name"] },
  { table: "referral_partners", name: "uq_referral_partner_name", cols: ["tenant_id", "name"] },
  { table: "segments", name: "uq_segments_name", cols: ["tenant_id", "name"] },
  { table: "templates", name: "uq_templates_name", cols: ["tenant_id", "name"] },
  { table: "workflows", name: "uq_workflows_name", cols: ["tenant_id", "name"] },
  { table: "units", name: "uq_units_building_number", cols: ["tenant_id", "building_id", "unit_number"] },
  { table: "support_tickets", name: "uq_support_ticket_number", cols: ["tenant_id", "number"] },
];

export async function up({ sequelize }: Ctx) {
  for (const i of INDEXES) {
    await step(() => sequelize.query(`ALTER TABLE \`${i.table}\` ADD COLUMN live_key TINYINT AS (IF(deleted_at IS NULL, 1, NULL)) STORED`));
    await step(() => sequelize.query(`ALTER TABLE \`${i.table}\` DROP INDEX \`${i.name}\`, ADD UNIQUE INDEX \`${i.name}\` (${[...i.cols, "live_key"].map((c) => `\`${c}\``).join(", ")})`));
  }
}

export async function down({ sequelize }: Ctx) {
  for (const i of INDEXES) {
    await step(() => sequelize.query(`ALTER TABLE \`${i.table}\` DROP INDEX \`${i.name}\`, ADD UNIQUE INDEX \`${i.name}\` (${i.cols.map((c) => `\`${c}\``).join(", ")})`));
    await step(() => sequelize.query(`ALTER TABLE \`${i.table}\` DROP COLUMN live_key`));
  }
}
