import {
  CreateOptions, DestroyOptions, FindOptions, Model, ModelStatic, Op, Transaction, UpdateOptions, WhereOptions, CountOptions,
} from "sequelize";
import type { RequestContext } from "./context";

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantViolationError";
  }
}

type TenantCtx = Pick<RequestContext, "tenantId">;
type AnyModel = ModelStatic<Model<any, any>>;

/**
 * The ONLY sanctioned way to touch a tenant-owned table.
 * tenantId comes from the authenticated context, is AND-ed into every read/update/delete predicate,
 * and is stamped on every insert. Caller-supplied tenantId values are rejected, never trusted.
 */

/**
 * `mysqlDate()` strings are UTC wall-clock text meant for RAW SQL. When one reaches a Sequelize MODEL write, Sequelize parses the text as
 * machine-local time, shifting the stored value by the server's UTC offset (4 hours on a Gulf server). Convert them to real Dates first.
 */
const UTC_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;
export function fixTimestamps<T extends Record<string, unknown>>(values: T): T {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" && /At$/.test(k) && UTC_TEXT.test(v)) (out ??= { ...values })[k] = new Date(`${v.replace(" ", "T")}${v.includes(".") ? "" : ".000"}Z`);
  }
  return (out ?? values) as T;
}

export class TenantRepository<M extends AnyModel = AnyModel> {
  constructor(readonly model: M, private readonly ctx: TenantCtx) {
    if (!ctx?.tenantId) throw new TenantViolationError("Repository requires a tenant context");
  }

  private scope(where?: WhereOptions): WhereOptions {
    return { [Op.and]: [where ?? {}, { tenantId: this.ctx.tenantId }] };
  }

  private assertNoForeignTenant(values: Record<string, unknown> | undefined) {
    if (values && "tenantId" in values && values.tenantId !== this.ctx.tenantId) {
      throw new TenantViolationError("Cross-tenant write rejected");
    }
  }

  findAll(opts: FindOptions = {}) {
    return this.model.findAll({ ...opts, where: this.scope(opts.where) });
  }

  findOne(opts: FindOptions = {}) {
    return this.model.findOne({ ...opts, where: this.scope(opts.where) });
  }

  findById(id: string, opts: Omit<FindOptions, "where"> = {}) {
    return this.model.findOne({ ...opts, where: this.scope({ id }) });
  }

  count(opts: CountOptions = {}) {
    return this.model.count({ ...opts, where: this.scope(opts.where) });
  }

  async create(values: Record<string, unknown>, opts: CreateOptions = {}) {
    this.assertNoForeignTenant(values);
    return this.model.create({ ...fixTimestamps(values), tenantId: this.ctx.tenantId } as never, opts);
  }

  async bulkCreate(rows: Record<string, unknown>[], opts: CreateOptions = {}) {
    rows.forEach((r) => this.assertNoForeignTenant(r));
    return this.model.bulkCreate(rows.map((r) => ({ ...fixTimestamps(r), tenantId: this.ctx.tenantId })) as never, opts as never);
  }

  /** Returns number of rows updated (0 when the id belongs to another tenant). */
  async updateById(id: string, values: Record<string, unknown>, opts: Omit<UpdateOptions, "where"> = {}) {
    this.assertNoForeignTenant(values);
    const { tenantId: _ignored, ...rest } = fixTimestamps(values);
    const [n] = await this.model.update(rest as never, { ...opts, where: this.scope({ id }) });
    return n;
  }

  async updateWhere(where: WhereOptions, values: Record<string, unknown>, opts: Omit<UpdateOptions, "where"> = {}) {
    this.assertNoForeignTenant(values);
    const { tenantId: _ignored, ...rest } = fixTimestamps(values);
    const [n] = await this.model.update(rest as never, { ...opts, where: this.scope(where) });
    return n;
  }

  deleteById(id: string, opts: Omit<DestroyOptions, "where"> = {}) {
    return this.model.destroy({ ...opts, where: this.scope({ id }) });
  }

  deleteWhere(where: WhereOptions, opts: Omit<DestroyOptions, "where"> = {}) {
    return this.model.destroy({ ...opts, where: this.scope(where) });
  }
}

export function repo<M extends AnyModel>(model: M, ctx: TenantCtx) {
  return new TenantRepository(model, ctx);
}

export type Tx = Transaction;
