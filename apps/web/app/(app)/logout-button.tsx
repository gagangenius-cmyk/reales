"use client";

import { useRouter } from "next/navigation";
import { postJson } from "@/lib/client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button className="btn-ghost text-sm" onClick={async () => { await postJson("/api/v1/auth/logout"); router.push("/login"); router.refresh(); }}>
      Sign out
    </button>
  );
}
