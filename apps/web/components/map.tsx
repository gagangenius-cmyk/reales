"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export interface MapPin { id: string; lat: number; lng: number; title: string; subtitle?: string; href?: string; image?: string | null; precise?: boolean; label?: string }

const TILES = process.env.NEXT_PUBLIC_MAP_TILES ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const UAE: [number, number] = [25.2, 55.27];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Map of listings. Each pin shows its price; pins whose position is only the centre of the community (no exact location recorded) are drawn faded so nobody
 * mistakes them for the exact address. With `onPick` the map is an editor: click or drag the pin to set coordinates.
 */
export default function MapView({ pins, height = 420, onPick, picked, zoomOnSingle = 15 }: { pins: MapPin[]; height?: number; onPick?: (lat: number, lng: number) => void; picked?: { lat: number; lng: number } | null; zoomOnSingle?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    let map: import("leaflet").Map | null = null, cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !el.current) return;
      map = L.map(el.current, { scrollWheelZoom: false }).setView(UAE, 9);
      L.tileLayer(TILES, { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
      const bounds: [number, number][] = [];
      for (const p of pins) {
        const icon = L.divIcon({ className: "", html: `<div style="transform:translate(-50%,-100%);background:${p.precise === false ? "#94a3b8" : "var(--pf, #4f46e5)"};color:#fff;font:600 11px system-ui;padding:3px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35);opacity:${p.precise === false ? 0.85 : 1}">${esc(p.label ?? "")}</div>`, iconSize: [0, 0] });
        const m = L.marker([p.lat, p.lng], { icon }).addTo(map);
        m.bindPopup(`<div style="min-width:160px">${p.image ? `<img src="${esc(p.image)}" alt="" style="width:100%;height:90px;object-fit:cover;border-radius:6px;margin-bottom:6px"/>` : ""}<b>${p.href ? `<a href="${esc(p.href)}">${esc(p.title)}</a>` : esc(p.title)}</b>${p.subtitle ? `<div style="font-size:12px;color:#64748b">${esc(p.subtitle)}</div>` : ""}${p.precise === false ? `<div style="font-size:11px;color:#94a3b8">Approximate: community centre</div>` : ""}</div>`);
        bounds.push([p.lat, p.lng]);
      }
      if (bounds.length === 1) map.setView(bounds[0]!, zoomOnSingle);
      else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
      if (pickRef.current) {
        let marker: import("leaflet").Marker | null = null;
        const put = (lat: number, lng: number) => {
          if (!marker) {
            marker = L.marker([lat, lng], { draggable: true }).addTo(map!);
            marker.on("dragend", () => { const c = marker!.getLatLng(); pickRef.current?.(Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6))); });
          } else marker.setLatLng([lat, lng]);
        };
        if (picked) { put(picked.lat, picked.lng); map.setView([picked.lat, picked.lng], 15); }
        map.on("click", (e) => { put(e.latlng.lat, e.latlng.lng); pickRef.current?.(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6))); });
      }
      setTimeout(() => map?.invalidateSize(), 50);
    })();
    return () => { cancelled = true; map?.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pins), picked?.lat, picked?.lng, height, zoomOnSingle]);

  return <div ref={el} style={{ height, width: "100%", borderRadius: 14, overflow: "hidden", border: "1px solid var(--border, #e5e7eb)", zIndex: 0 }} role="region" aria-label="Map" />;
}
