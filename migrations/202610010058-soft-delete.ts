import { DataTypes } from "sequelize";
import { Ctx, step } from "./_helpers";

/**
 * Soft delete. Business records that people create and may remove by mistake get deleted_at / deleted_by instead of being erased, so they can be restored
 * from Trash. Deliberately NOT included: finance, commissions, deals and offers, leases, compliance and KYC, audit and outbox, identity and sessions, and
 * link or history tables. Those are corrected by status changes or reversing entries, never by deletion.
 */
export const SOFT_DELETE_TABLES = [
  "organizations", "contacts", "leads", "tasks", "developers", "real_estate_projects", "buildings", "units", "listings", "viewings", "templates", "segments",
  "campaigns", "workflows", "bots", "vendors", "portfolios", "saved_searches", "referral_partners", "notice_posts", "support_tickets", "lead_pools", "documents",
] as const;

export async function up({ context: qi }: Ctx) {
  for (const t of SOFT_DELETE_TABLES) {
    await step(() => qi.addColumn(t, "deleted_at", { type: DataTypes.DATE(3), allowNull: true }));
    await step(() => qi.addColumn(t, "deleted_by", { type: DataTypes.UUID, allowNull: true }));
    await step(() => qi.addIndex(t, ["tenant_id", "deleted_at"], { name: `ix_${t}_deleted`.slice(0, 60) }));
  }
}

export async function down({ context: qi }: Ctx) {
  for (const t of SOFT_DELETE_TABLES) {
    await step(() => qi.removeIndex(t, `ix_${t}_deleted`.slice(0, 60)));
    await step(() => qi.removeColumn(t, "deleted_by"));
    await step(() => qi.removeColumn(t, "deleted_at"));
  }
}
