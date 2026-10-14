"use client";

import { useRouter } from "next/navigation";
import { postJson } from "@/lib/client";

export function LanguageSwitch({ lang }: { lang: "en" | "ar" }) {
  const router = useRouter();
  const next = lang === "en" ? "ar" : "en";
  return (
    <button className="btn-ghost text-sm" lang={next} onClick={async () => { await postJson("/api/v1/preferences/language", { lang: next }); router.refresh(); }}>
      {next === "ar" ? "العربية" : "English"}
    </button>
  );
}
