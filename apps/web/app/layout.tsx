import type { Metadata } from "next";
import { getLang } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = { title: "Reales CRM", description: "UAE real-estate operating system" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
