import {
  acceptOffer, advanceDealStage, completeMilestone, createContact, createDeal, createOffer, createReservation,
} from "@reales/domain";
import { contextFor, testDb, uniq } from "./helpers";
import { agentIn, makeInventory, makeOrg, Tenant } from "./brokerage-helpers";

const sq = () => testDb();
export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
let n = 0;
export const phone = () => `05${String(50000000 + ++n * 17 + Math.floor(Math.random() * 9)).padStart(8, "0")}`;

export async function kit(t: Tenant) {
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id);
  const other = await agentIn(t, org.marina.id, org.bu.id);
  const mgr = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
  const inv = await makeInventory(t);
  const contact = await createContact(sq(), t.admin, { firstName: uniq("Buyer"), phone: phone() });
  return { org, agent, other, mgr, inv, contact };
}

export async function acceptedOffer(t: Tenant, k: Awaited<ReturnType<typeof kit>>, o: { amount?: number; leadId?: string } = {}) {
  const offer = await createOffer(sq(), k.agent.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, amount: o.amount ?? 1_950_000, depositAmount: 100_000, leadId: o.leadId });
  return acceptOffer(sq(), k.mgr.ctx, offer.id);
}

export async function openDeal(t: Tenant, k: Awaited<ReturnType<typeof kit>>, o: { amount?: number; leadId?: string } = {}) {
  const offer = await acceptedOffer(t, k, o);
  const res = await createReservation(sq(), k.mgr.ctx, { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.id, depositAmount: 100_000 });
  const deal = await createDeal(sq(), k.mgr.ctx, { reservationId: res.id });
  return { offer, res, deal };
}

/** Walk a deal through the manual overrides needed to reach `to` (used to test the closing side effects). */
export async function walkTo(k: Awaited<ReturnType<typeof kit>>, dealId: string, to: "contract" | "signed" | "payment" | "registration" | "closed") {
  const order = ["contract", "signed", "payment", "registration", "closed"] as const;
  const mgr = await contextFor(k.agent.ctx.tenantId, k.mgr.id);
  for (const stage of order) {
    if (stage === "contract") await completeMilestone(sq(), mgr, dealId, "deposit", { reason: "deposit confirmed by bank statement" });
    if (stage === "signed") await completeMilestone(sq(), mgr, dealId, "contract_signed", { reason: "wet-ink contract received" });
    if (stage === "closed") await completeMilestone(sq(), mgr, dealId, "registration_completed");
    await advanceDealStage(sq(), mgr, dealId, { to: stage });
    if (stage === to) return;
  }
}

