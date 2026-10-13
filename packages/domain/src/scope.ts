import { Op, WhereOptions, literal } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import type { Uow } from "./uow";

/** Attribute (camelCase) names of the columns that carry ownership / organisational location on a model. */
export interface ScopeColumns {
  owner?: string;
  branch?: string;
  businessUnit?: string;
  project?: string;
  portfolio?: string;
  /** Extra SQL (already escaped) that also grants own_records access, e.g. contacts whose lead is assigned to me. */
  alsoOwnedVia?: (ctx: RequestContext) => string;
}

/**
 * Translate the user's grants for a permission into a row filter for list/read queries.
 * - returns `{}` when a tenant-wide grant exists (no extra filtering; tenant_id is added by the repository)
 * - returns a WHERE fragment (OR of the user's scopes) otherwise
 * - throws ForbiddenError when the user holds no grant of the permission at all
 * A grant whose scope cannot be evaluated on this model (e.g. `project` on a table without a project column)
 * contributes nothing: fail closed.
 */
export async function scopeWhere(u: Uow, ctx: RequestContext, permission: string, cols: ScopeColumns): Promise<WhereOptions> {
  const grants = ctx.grants.filter((g) => g.permission === permission);
  if (grants.length === 0) throw new ForbiddenError(`Missing permission: ${permission}`);
  if (grants.some((g) => g.scope === "tenant")) return {};

  const ors: WhereOptions[] = [];
  const inList = (col: string, anchor: string | null | undefined, ids: string[]) =>
    anchor ? { [col]: anchor } : { [col]: { [Op.in]: ids.length ? ids : ["00000000-0000-0000-0000-000000000000"] } };

  for (const g of grants) {
    switch (g.scope) {
      case "own_records":
        if (cols.owner) ors.push({ [cols.owner]: ctx.userId });
        if (cols.alsoOwnedVia) ors.push(literal(cols.alsoOwnedVia(ctx)));
        break;
      case "branch":
        if (cols.branch) ors.push(inList(cols.branch, g.anchorId, ctx.membership.branchIds));
        break;
      case "business_unit": {
        const ids = g.anchorId ? [g.anchorId] : ctx.membership.businessUnitIds;
        if (cols.businessUnit) ors.push(inList(cols.businessUnit, g.anchorId, ctx.membership.businessUnitIds));
        else if (cols.branch) {
          const list = ids.length ? ids.map((i) => u.sq.escape(i)).join(",") : "NULL";
          ors.push(literal(`${cols.branch.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())} IN (SELECT id FROM branches WHERE tenant_id = ${u.sq.escape(ctx.tenantId)} AND business_unit_id IN (${list}))`));
        }
        break;
      }
      case "project":
        if (cols.project) ors.push(inList(cols.project, g.anchorId, ctx.membership.projectIds));
        break;
      case "portfolio":
        if (cols.portfolio) ors.push(inList(cols.portfolio, g.anchorId, ctx.membership.portfolioIds));
        break;
    }
  }
  // No evaluable scope: match nothing rather than everything.
  return ors.length ? { [Op.or]: ors } : literal("1 = 0");
}

export const plain = (m: any) => (m && typeof m.get === "function" ? m.get({ plain: true }) : m);
export const attr = (m: any, k: string) => m.get(k);
