import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getContact, getKycProfileByContact, getUboGraph } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../../no-access";
import { KycPanel } from "./kyc-panel";

export const metadata = { title: "KYC | Reales CRM" };

export default async function KycPage({ params }: { params: Promise<{ contactId: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "kyc.read")) return <NoAccess />;
  const { contactId } = await params;
  const sq = getSequelize();
  let contact: any, profile: any;
  try { contact = await getContact(sq, ctx, contactId); profile = await getKycProfileByContact(sq, ctx, contactId); } catch {
    return <section><h1 className="text-2xl font-semibold">Contact not found</h1><Link className="btn-ghost mt-3 inline-block" href="/compliance">Back</Link></section>;
  }
  const ubo: any = contact.type === "company" ? await getUboGraph(sq, ctx, contactId).catch(() => null) : null;
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.companyName || "Contact";
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/compliance">Back to compliance</Link>
        <h1 className="text-2xl font-semibold">KYC - {name}</h1>
        <p className="muted text-sm">{contact.type === "company" ? "Entity (KYB)" : "Individual"}{profile ? ` - ${profile.status}, risk ${profile.riskLevel}${profile.riskScore != null ? ` (${profile.riskScore})` : ""}${profile.isPep ? ", PEP" : ""}` : " - no profile yet"}</p>
      </div>
      <KycPanel contactId={contactId} isEntity={contact.type === "company"} profile={profile} ubo={ubo}
        can={{ manage: hasPermission(ctx, "kyc.manage"), review: hasPermission(ctx, "kyc.review"), screen: hasPermission(ctx, "screening.run"), dispose: hasPermission(ctx, "screening.dispose") }} />
    </section>
  );
}
