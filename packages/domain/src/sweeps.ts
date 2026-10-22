import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { systemContext } from "@reales/database";
import { logger } from "@reales/observability";
import { tickCampaigns } from "./campaigns";
import { unpublishNonCompliant } from "./listings";
import { expireOffers, expireReservations } from "./offers";
import { processDueWaits } from "./workflows";
import { leaseSweep } from "./leases";
import { ticketSlaSweep } from "./maintenance";
import { kycExpirySweep } from "./compliance";
import { dsrSweep } from "./privacy";
import { rescoreOpenLeads } from "./scoring";
import { matchSweep } from "./matching";
import { settleDueReferrals } from "./referrals";
import { taskReminderSweep } from "./calendar";
import { repoolSweep } from "./pools";
import { listingLifecycleSweep } from "./listing-details";
import { deliverQueuedPublications } from "./syndication";
import { attendanceCloseSweep } from "./hr-attendance";
import { hrExpirySweep } from "./hr-people";
import { dailyDigestSweep, deliverQueuedEmails, followUpOverdueSweep } from "./notify";

export interface SweepResult { tenantId: string; offersExpired: number; reservationsExpired: number; listingsUnpublished: number; workflowsResumed: number; campaignBatches: number; leaseNotices: number; slaBreaches: number; kycExpired: number; dsrOverdue: number; leadsScored: number; matchAlerts: number; referralsSettled: number; taskReminders: number; leadsRepooled: number; listingsExpired: number; error?: string }

/**
 * Business deadlines live in the database, not in queue timers (BullMQ delays are not exact and are not the record of truth).
 * A scheduler calls this periodically; it is idempotent and tenant-scoped, and one tenant's failure never stops the others.
 */
export async function runSweeps(sq: Sequelize, o: { tenantIds?: string[] } = {}): Promise<SweepResult[]> {
  const all = await sq.query<{ id: string }>("SELECT id FROM tenants WHERE status='active'", { type: QueryTypes.SELECT });
  const tenants = o.tenantIds ? all.filter((t) => o.tenantIds!.includes(t.id)) : all;
  const out: SweepResult[] = [];
  for (const t of tenants) {
    const ctx = systemContext(t.id, `corr_sweep_${randomUUID()}`);
    try {
      const offers = await expireOffers(sq, ctx);
      const reservations = await expireReservations(sq, ctx);
      const listings = await unpublishNonCompliant(sq, ctx);
      const waits = await processDueWaits(sq, t.id);
      const campaigns = await tickCampaigns(sq, t.id);
      const leases = await leaseSweep(sq, ctx);
      const slaBreaches = await ticketSlaSweep(sq, ctx);
      const kycExpired = await kycExpirySweep(sq, ctx);
      const dsrOverdue = await dsrSweep(sq, ctx);
      const leadsScored = await rescoreOpenLeads(sq, ctx);
      const matches = await matchSweep(sq, ctx);
      const referralsSettled = await settleDueReferrals(sq, ctx);
      const taskReminders = await taskReminderSweep(sq, ctx);
      const repooled = await repoolSweep(sq, ctx);
      const lifecycle = await listingLifecycleSweep(sq, ctx);
      await deliverQueuedPublications(sq, ctx);
      await followUpOverdueSweep(sq, ctx);
      await dailyDigestSweep(sq, ctx);
      await deliverQueuedEmails(sq, ctx);
      await attendanceCloseSweep(sq, ctx);
      await hrExpirySweep(sq, ctx);
      out.push({ tenantId: t.id, offersExpired: offers.length, reservationsExpired: reservations.length, listingsUnpublished: listings.length, workflowsResumed: waits.resumed + waits.timedOut, campaignBatches: campaigns.length, leaseNotices: leases.ended + leases.overdueMarked + leases.expiringNotices, slaBreaches, kycExpired, dsrOverdue, leadsScored, matchAlerts: matches.leadAlerts + matches.searchAlerts, referralsSettled, taskReminders, leadsRepooled: repooled.reassigned + repooled.pooled, listingsExpired: lifecycle.expired });
    } catch (e) {
      logger.error({ err: e, tenantId: t.id }, "sweep failed for tenant");
      out.push({ tenantId: t.id, offersExpired: 0, reservationsExpired: 0, listingsUnpublished: 0, workflowsResumed: 0, campaignBatches: 0, leaseNotices: 0, slaBreaches: 0, kycExpired: 0, dsrOverdue: 0, leadsScored: 0, matchAlerts: 0, referralsSettled: 0, taskReminders: 0, leadsRepooled: 0, listingsExpired: 0, error: String((e as Error).message) });
    }
  }
  return out;
}
