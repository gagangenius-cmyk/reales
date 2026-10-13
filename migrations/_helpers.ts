import { DataTypes, QueryInterface, Sequelize } from "sequelize";

export type Ctx = { context: QueryInterface; sequelize: Sequelize };

export const id = () => ({ type: DataTypes.UUID, primaryKey: true, allowNull: false });
export const tenantId = () => ({
  type: DataTypes.UUID, allowNull: false,
  references: { model: "tenants", key: "id" }, onDelete: "RESTRICT",
});
export const ts = () => ({
  created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
});
export const uuid = (allowNull = true) => ({ type: DataTypes.UUID, allowNull });
export const str = (n: number, allowNull = false) => ({ type: DataTypes.STRING(n), allowNull });
export const json = (allowNull = true) => ({ type: DataTypes.JSON, allowNull });
export const dt = (allowNull = true) => ({ type: DataTypes.DATE(3), allowNull });

/** Parent tables need UNIQUE (tenant_id, id) so children can use composite tenant-safe foreign keys. */
export async function tenantKey(qi: QueryInterface, table: string) {
  await qi.addIndex(table, ["tenant_id", "id"], { unique: true, name: `uq_${table}_tenant_id` });
}

/**
 * Composite FK (tenant_id, col) -> parent (tenant_id, id): the database itself refuses a row that points at
 * another tenant's record, independent of application-level checks.
 */
export async function tenantFk(
  sequelize: Sequelize, table: string, col: string, parent: string, onDelete: "RESTRICT" | "CASCADE" | "SET NULL" = "RESTRICT",
) {
  const setNull = onDelete === "SET NULL"; // SET NULL would null tenant_id too; use RESTRICT semantics for nullable refs
  await sequelize.query(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT \`fk_${table}_${col}\` FOREIGN KEY (tenant_id, \`${col}\`) REFERENCES \`${parent}\` (tenant_id, id) ON DELETE ${setNull ? "RESTRICT" : onDelete}`,
  );
}
