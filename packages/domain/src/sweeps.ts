import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { systemContext } from "@reales/database";
import { logger } from "@reales/observability";
import { tickCampaigns } from "./campaigns";
import { unpublishNonCompliant } from "./listings";
import { expireOffers, expireReservations } from "./offers";
import { processDueWaits } from "./workflows";

export interface SweepResult { tenantId: string; offersExpired: number; reservationsExpired: number; listingsUnpublished: number; workflowsResumed: number; campaignBatches: number; error?: string }

/**
 * Business deadlines live in the database, not in queue timers (BullMQ delays are not exact and are not the record of truth).
 * A scheduler calls this periodically; it is idempotent and tenant-scoped, and one tenant's failure never stops the others.
 */
export async function runSweeps(sq: Sequelize): Promise<SweepResult[]> {
  const tenants = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE status='active'", { type: QueryTypes.SELECT });
  const out: SweepResult[] = [];
  for (const t of tenants) {
    const ctx = systemContext(t.id, `corr_sweep_${randomUUID()}`);
    try {
      const offers = await expireOffers(sq, ctx);
      const reservations = await expireReservations(sq, ctx);
      const listings = await unpublishNonCompliant(sq, ctx);
      const waits = await processDueWaits(sq, t.id);
      const campaigns = await tickCampaigns(sq, t.id);
      out.push({ tenantId: t.id, offersExpired: offers.length, reservationsExpired: reservations.length, listingsUnpublished: listings.length, workflowsResumed: waits.resumed + waits.timedOut, campaignBatches: campaigns.length });
    } catch (e) {
      logger.error({ err: e, tenantId: t.id }, "sweep failed for tenant");
      out.push({ tenantId: t.id, offersExpired: 0, reservationsExpired: 0, listingsUnpublished: 0, workflowsResumed: 0, campaignBatches: 0, error: String((e as Error).message) });
    }
  }
  return out;
}
