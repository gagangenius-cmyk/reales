import { DataTypes } from "sequelize";
import { Ctx, id, str, tenantId, json } from "./_helpers";

export async function up({ context: qi, sequelize }: Ctx) {
  await qi.createTable("audit_events", {
    id: id(), tenant_id: tenantId(), seq: { type: DataTypes.BIGINT, allowNull: false },
    actor_id: str(64, true), action: str(100), entity_type: str(60, true), entity_id: str(64, true),
    before: json(), after: json(), reason: str(500, true),
    correlation_id: str(80), ip: str(64, true),
    prev_hash: { type: DataTypes.STRING(64), allowNull: true },
    hash: { type: DataTypes.STRING(64), allowNull: false },
    created_at: { type: DataTypes.DATE(3), allowNull: false },
  });
  await qi.addIndex("audit_events", ["tenant_id", "seq"], { unique: true, name: "uq_audit_tenant_seq" });
  await qi.addIndex("audit_events", ["tenant_id", "entity_type", "entity_id"], { name: "ix_audit_entity" });
  await qi.addIndex("audit_events", ["tenant_id", "actor_id", "created_at"], { name: "ix_audit_actor" });
  // Immutable administrative audit log (blueprint): the database itself rejects UPDATE and DELETE.
  await sequelize.query(`CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is append-only'`);
  await sequelize.query(`CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_events is append-only'`);
}
export async function down({ context: qi, sequelize }: Ctx) {
  await sequelize.query("DROP TRIGGER IF EXISTS audit_events_no_update");
  await sequelize.query("DROP TRIGGER IF EXISTS audit_events_no_delete");
  await qi.dropTable("audit_events");
}
