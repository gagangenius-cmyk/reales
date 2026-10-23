import "../../p/site.css";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSequelize } from "@reales/database";
import { publicLeadFormInfo } from "@reales/domain";
import { LeadForm } from "./lead-form";

export const metadata: Metadata = { title: "Contact us", robots: { index: false } };

/** Hosted lead-capture page for a website-type lead source. Linked from campaigns, QR codes on signage, and social bios. */
export default async function PublicLeadForm({ params, searchParams }: { params: Promise<{ publicId: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { publicId } = await params;
  const info = await publicLeadFormInfo(getSequelize(), publicId);
  if (!info) notFound();
  const lang = (await searchParams).lang === "ar" ? "ar" : "en";
  return (
    <div className="pf" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} style={{ ["--pf" as string]: "#4f46e5", display: "grid", placeItems: "center", padding: 16 }}>
      <main className="pf-panel" style={{ width: "100%", maxWidth: 480, marginTop: 32 }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 800 }}>{info.company}</h1>
        <p className="pf-mute" style={{ margin: "6px 0 18px" }}>{lang === "ar" ? "اترك بياناتك وسيتواصل معك أحد مستشارينا قريباً." : "Leave your details and one of our advisers will contact you shortly."}</p>
        <LeadForm publicId={publicId} lang={lang} defaultPurpose={info.purpose} />
        <p className="pf-mute" style={{ fontSize: ".75rem", marginTop: 14 }}>{lang === "ar" ? "باستخدام هذا النموذج فإنك توافق على تواصلنا معك بخصوص طلبك." : "By sending this form you agree that we may contact you about your enquiry."}</p>
      </main>
    </div>
  );
}
