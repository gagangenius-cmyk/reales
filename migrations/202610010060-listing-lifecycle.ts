import { DataTypes } from "sequelize";
import { Ctx, step, dt, str } from "./_helpers";

/**
 * Full listing lifecycle: draft -> published -> (unpublished | expired | closed) -> archived. "Closed" means the property was sold or let (or withdrawn),
 * optionally tied to the deal; "archived" moves a finished listing out of the working list without losing it.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  await step(() => sequelize.query("ALTER TABLE listings MODIFY COLUMN status ENUM('draft','published','unpublished','expired','closed','archived') NOT NULL"));
  await step(() => qi.addColumn("listings", "closed_at", dt()));
  await step(() => qi.addColumn("listings", "closed_outcome", { type: DataTypes.ENUM("sold", "rented", "withdrawn"), allowNull: true }));
  await step(() => qi.addColumn("listings", "closed_note", str(300, true)));
  await step(() => qi.addColumn("listings", "closed_deal_id", { type: DataTypes.UUID, allowNull: true }));
  await step(() => qi.addColumn("listings", "archived_at", dt()));
  await step(() => qi.addColumn("listings", "status_before_archive", str(20, true)));
}

export async function down({ context: qi, sequelize }: Ctx) {
  for (const c of ["status_before_archive", "archived_at", "closed_deal_id", "closed_note", "closed_outcome", "closed_at"]) await step(() => qi.removeColumn("listings", c));
  await step(() => sequelize.query("UPDATE listings SET status='unpublished' WHERE status IN ('expired','closed','archived')"));
  await step(() => sequelize.query("ALTER TABLE listings MODIFY COLUMN status ENUM('draft','published','unpublished') NOT NULL"));
}
