/** A single permission grant with its scope (blueprint: roles + scopes + explicit permissions). */
export type ScopeType = "tenant" | "business_unit" | "branch" | "project" | "portfolio" | "own_records";

export interface Grant {
  permission: string;
  scope: ScopeType;
  /** When set, the grant only applies to this business_unit/branch/project/portfolio id. */
  anchorId?: string | null;
}

/**
 * Derived ONLY from the authenticated session (never from request body/query).
 * Every repository and every background job carries one of these.
 */
export interface RequestContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  correlationId: string;
  grants: Grant[];
  /** Organisational memberships used to evaluate scoped grants. */
  membership: { businessUnitIds: string[]; branchIds: string[]; projectIds: string[]; portfolioIds: string[] };
  stepUpValid: boolean;
  ip?: string | null;
  userAgent?: string | null;
  /** Set when an operator is impersonating (reason is mandatory and audited). */
  impersonatedBy?: string | null;
}

/** Immutable tenancy metadata every background job must carry. */
export interface JobMeta {
  tenantId: string;
  projectId?: string | null;
  actorId?: string | null;
  correlationId: string;
}

export function jobMetaFrom(ctx: Pick<RequestContext, "tenantId" | "userId" | "correlationId">, projectId?: string | null): JobMeta {
  return Object.freeze({ tenantId: ctx.tenantId, actorId: ctx.userId, correlationId: ctx.correlationId, projectId: projectId ?? null });
}

export function systemContext(tenantId: string, correlationId: string): RequestContext {
  return {
    tenantId,
    userId: "system",
    sessionId: "system",
    correlationId,
    grants: [],
    membership: { businessUnitIds: [], branchIds: [], projectIds: [], portfolioIds: [] },
    stepUpValid: false,
  };
}
