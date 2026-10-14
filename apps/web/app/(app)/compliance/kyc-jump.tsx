"use client";

import { useRouter } from "next/navigation";

/** Navigate to the KYC page of the contact picked in the select next to it. */
export function KycJump() {
  const router = useRouter();
  return <button type="button" className="btn" onClick={() => { const v = (document.getElementById("kyc-contact") as HTMLSelectElement | null)?.value; if (v) router.push(`/compliance/kyc/${v}`); }}>Open KYC</button>;
}
