import type { Metadata } from "next";
import { getLang } from "@/lib/i18n";
import "./globals.css";
import { RegisterServiceWorker } from "./register-sw";

export const metadata: Metadata = { title: "Reales CRM", description: "UAE real-estate operating system", applicationName: "Reales CRM", appleWebApp: { capable: true, title: "Reales", statusBarStyle: "black-translucent" } };
export const viewport = { themeColor: "#2563eb" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = await getLang();
  return (
    <html lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: "try{if(localStorage.getItem('reales-sidebar')==='collapsed')document.documentElement.dataset.sidebar='collapsed'}catch(e){}" }} /></head>
      <body className="min-h-screen antialiased">{children}<RegisterServiceWorker /></body>
    </html>
  );
}
