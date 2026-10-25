import { Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { listLocations } from "./locations";
import type { ListingFilters } from "./filters";

/**
 * Search listings in plain words: "2 bed apartment in dubai marina under 2m", "furnished studio for rent below 80k", "villas between 3m and 6m".
 * The sentence is read with fixed rules (no model, nothing leaves the server) into the same filters the Listings page uses, and the parts it understood are
 * returned so the person can see exactly what was searched for. Words it does not recognise stay as a text search.
 */
export interface SmartQuery { filters: ListingFilters; understood: string[]; community?: string; leftover: string }

const TYPE_WORDS: [RegExp, string, string][] = [
  [/\bhotel apartments?\b/, "hotel_apartment", "hotel apartment"], [/\b(?:apartments?|flats?)\b/, "apartment", "apartment"], [/\bvillas?\b/, "villa", "villa"], [/\btown ?houses?\b/, "townhouse", "townhouse"],
  [/\bpent ?houses?\b/, "penthouse", "penthouse"], [/\bduplex(?:es)?\b/, "duplex", "duplex"], [/\bstudios?\b/, "studio", "studio"], [/\b(?:offices?|office space)\b/, "office", "office"],
  [/\b(?:shops?|retail)\b/, "retail", "retail"], [/\bwarehouses?\b/, "warehouse", "warehouse"], [/\b(?:land|plots?)\b/, "land", "land"],
];

/** "2m" -> 2,000,000, "150k" -> 150,000, "1.5 million" -> 1,500,000, "2,500,000" -> 2500000. */
export function parseMoney(raw: string): number | null {
  const m = /^(\d[\d,]*(?:\.\d+)?)\s*(m|mn|million|k|thousand)?$/.exec(raw.trim().toLowerCase().replace(/^aed\s*/, "").replace(/\s+/g, " "));
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, "")), unit = m[2];
  const v = unit?.startsWith("m") ? n * 1_000_000 : unit === "k" || unit === "thousand" ? n * 1_000 : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

const MONEY = String.raw`(?:aed\s*)?\d[\d,]*(?:\.\d+)?\s*(?:m|mn|million|k|thousand)?`;

export async function smartListingQuery(sq: Sequelize, ctx: RequestContext, text: string): Promise<SmartQuery> {
  let t = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const f: ListingFilters = {};
  const understood: string[] = [];
  const take = (re: RegExp) => { const m = re.exec(t); if (m) t = t.replace(m[0], " "); return m; };

  // price ranges first, so their numbers are not read as bedrooms
  let m = take(new RegExp(String.raw`\bbetween\s+(${MONEY})\s+(?:and|to|-)\s+(${MONEY})\b`)) ?? take(new RegExp(String.raw`\b(${MONEY})\s*(?:-|to)\s*(${MONEY})\b(?=\s|$)`));
  if (m) { const a = parseMoney(m[1]!), b = parseMoney(m[2]!); if (a && b) { f.minPrice = Math.min(a, b); f.maxPrice = Math.max(a, b); understood.push(`price AED ${f.minPrice.toLocaleString("en-US")} to ${f.maxPrice.toLocaleString("en-US")}`); } }
  if (f.maxPrice === undefined) {
    m = take(new RegExp(String.raw`\b(?:under|below|less than|up to|max(?:imum)?|within|budget(?: of)?|upto)\s+(${MONEY})\b`));
    if (m) { const v = parseMoney(m[1]!); if (v) { f.maxPrice = v; understood.push(`up to AED ${v.toLocaleString("en-US")}`); } }
  }
  if (f.minPrice === undefined) {
    m = take(new RegExp(String.raw`\b(?:over|above|more than|from|min(?:imum)?|at least)\s+(${MONEY})\b`));
    if (m) { const v = parseMoney(m[1]!); if (v) { f.minPrice = v; understood.push(`from AED ${v.toLocaleString("en-US")}`); } }
  }

  // bedrooms
  m = take(/\b(\d{1,2})\s*(?:\+|plus)?\s*(?:br|bhk|bed(?:room)?s?)\b/);
  if (m) { const n = Number(m[1]); f.bedsMin = n; f.bedsMax = /plus|\+/.test(m[0]) ? undefined : n; understood.push(`${n}${/plus|\+/.test(m[0]) ? "+" : ""} bedroom${n === 1 ? "" : "s"}`); }
  if (/\bstudio\b/.test(t)) { f.bedsMin = 0; f.bedsMax = 0; }

  // type
  for (const [re, value, label] of TYPE_WORDS) if (take(re)) { f.types = [value]; understood.push(label); if (value === "studio") { f.bedsMin = 0; f.bedsMax = 0; } break; }

  // purpose, furnishing, state
  if (take(/\b(?:for rent|to rent|to let|rental|rent)\b/)) { f.purpose = "rent"; understood.push("for rent"); }
  else if (take(/\b(?:for sale|to buy|buy|sale|purchase)\b/)) { f.purpose = "sale"; understood.push("for sale"); }
  if (take(/\b(?:unfurnished)\b/)) { f.furnishing = "unfurnished"; understood.push("unfurnished"); }
  else if (take(/\b(?:semi[- ]furnished|partly furnished)\b/)) { f.furnishing = "semi_furnished"; understood.push("semi-furnished"); }
  else if (take(/\b(?:furnished)\b/)) { f.furnishing = "furnished"; understood.push("furnished"); }
  if (take(/\bfeatured\b/)) { f.featured = true; understood.push("featured"); }
  if (take(/\b(?:no photos?|without photos?|missing photos?)\b/)) { f.noPhotos = true; understood.push("no photos"); }
  for (const s of ["published", "draft", "unpublished", "expired", "closed", "archived"] as const) if (take(new RegExp(String.raw`\b${s}\b`))) { f.status = s; understood.push(s); break; }

  // community: the longest known location name that appears in the sentence
  let community: string | undefined;
  const locs = await listLocations(sq, ctx).catch(() => []);
  const names = [...new Set((locs as any[]).flatMap((l) => [l.subCommunity, l.community].filter(Boolean) as string[]))];
  const short = (n: string) => n.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase();
  const hit = names.map((n) => ({ n, k: short(n), alt: /\(([^)]+)\)/.exec(n)?.[1]?.toLowerCase() })).filter((x) => t.includes(` ${x.k} `) || t.includes(` ${x.k}`) || (x.alt && t.includes(` ${x.alt} `))).sort((a, b) => b.k.length - a.k.length)[0];
  if (hit) { community = hit.n; f.community = locs.find((l: any) => l.subCommunity === hit.n)?.community ?? hit.n; t = t.replace(hit.k, " ").replace(hit.alt ?? "\u0000", " "); understood.push(`in ${hit.n}`); }

  const leftover = t.replace(/\b(?:in|at|near|with|a|an|the|me|show|find|search|for|looking|want|i|need|properties|property|listings?|available|please|and|of)\b/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
  if (leftover) f.q = leftover;
  return { filters: f, understood, community, leftover };
}

/** The same filters as the Listings page's address-bar parameters, so a smart search can be shown (and shared) as an ordinary filtered list. */
export function listingParams(f: ListingFilters): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.q) p.q = f.q; if (f.status) p.status = f.status; if (f.purpose) p.purpose = f.purpose; if (f.types?.[0]) p.type = f.types[0];
  if (f.bedsMin !== undefined) p.bedsMin = String(f.bedsMin); if (f.bedsMax !== undefined) p.bedsMax = String(f.bedsMax);
  if (f.minPrice !== undefined) p.minPrice = String(f.minPrice); if (f.maxPrice !== undefined) p.maxPrice = String(f.maxPrice);
  if (f.community) p.community = f.community; if (f.furnishing) p.furnishing = f.furnishing; if (f.featured) p.featured = "1"; if (f.noPhotos) p.noPhotos = "1";
  return p;
}
