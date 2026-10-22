"use client";

import dynamic from "next/dynamic";

/** Leaflet touches `window`, so the map is only loaded in the browser. */
export const LazyMap = dynamic(() => import("./map"), { ssr: false, loading: () => <div className="muted grid h-64 place-items-center rounded-xl border text-sm" style={{ borderColor: "var(--border, #e5e7eb)" }}>Loading map...</div> });
export type { MapPin } from "./map";
