import type { MetadataRoute } from "next";

/** Makes the CRM installable on a phone or desktop ("Add to home screen"), opening full screen on the dashboard. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Reales CRM", short_name: "Reales", description: "Real estate CRM for the UAE", start_url: "/dashboard", scope: "/", display: "standalone", orientation: "portrait",
    background_color: "#0f172a", theme_color: "#2563eb",
    icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }],
    shortcuts: [{ name: "Leads", url: "/leads" }, { name: "Listings", url: "/listings" }, { name: "Calls", url: "/calls" }],
  };
}
