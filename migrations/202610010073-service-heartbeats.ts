import { DataTypes } from "sequelize";
import { Ctx, step } from "./_helpers";

/** Background services (scheduler, worker) record that they are alive, so a monitor can tell when the work that Vercel cannot run has stopped. Global, no tenant data. */
export async function up({ context: qi }: Ctx) {
  await step(() => qi.createTable("service_heartbeats", {
    service: { type: DataTypes.STRING(40), allowNull: false },
    instance: { type: DataTypes.STRING(80), allowNull: false },
    beat_at: { type: DataTypes.DATE(3), allowNull: false },
    started_at: { type: DataTypes.DATE(3), allowNull: false },
    details: { type: DataTypes.JSON, allowNull: true },
  }));
  await step(() => qi.addConstraint("service_heartbeats", { fields: ["service", "instance"], type: "primary key", name: "pk_service_heartbeats" }));
}
export async function down({ context: qi }: Ctx) {
  await qi.dropTable("service_heartbeats");
}
