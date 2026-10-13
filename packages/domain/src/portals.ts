import { createHash } from "node:crypto";
import { canonicalJson } from "@reales/database";

/** Canonical listing snapshot: the portal-neutral shape we own. Portal schemas never leak into our database. */
export interface CanonicalListing {
  listingId: string;
  reference: string;
  purpose: "sale" | "rent";
  title: string;
  description: string;
  price: number;
  currency: string;
  jurisdiction: string;
  property: { type: string; bedrooms: number | null; bathrooms: number | null; areaSqft: number | null; unitNumber: string; floor: number | null; view: string | null };
  location: { building: string; community: string | null; city: string | null; project: string; offPlan: boolean; projectRegistrationNo: string | null };
  agent: { name: string | null; email: string | null; licenceNo: string | null };
  brokerage: { name: string | null; licenceNo: string | null };
  permit: { number: string; authority: string; expiresAt: string } | null;
  media: Array<{ kind: string; key: string; position: number }>;
  capturedAt: string;
}

export type PortalAction = "publish" | "update" | "unpublish";
export interface PortalPayload { format: "xml" | "json"; payload: string }

/** Every portal implements this; domain code never branches on a portal name. */
export interface ListingPortalProvider {
  readonly code: string;
  readonly label: string;
  transform(snapshot: CanonicalListing, action: PortalAction): PortalPayload;
}

const registry = new Map<string, ListingPortalProvider>();
export const registerPortalProvider = (p: ListingPortalProvider) => void registry.set(p.code, p);
export const getPortalProvider = (code: string) => registry.get(code) ?? null;
export const listPortalProviders = () => [...registry.values()].map((p) => ({ code: p.code, label: p.label }));

export const snapshotHash = (s: unknown) => createHash("sha256").update(canonicalJson(s)).digest("hex");

const xml = (v: unknown) => String(v ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/**
 * Bayut/dubizzle-style XML feed item. Field names are a plausible mapping, NOT a verified portal contract:
 * the real schema must be validated against the portal's current documentation before switching an account to live sync.
 */
export const bayutProvider: ListingPortalProvider = {
  code: "bayut",
  label: "Bayut / dubizzle (XML export)",
  transform(s, action) {
    const status = action === "unpublish" ? "deleted" : "live";
    const body = `<Property>
  <Property_Ref_No>${xml(s.reference)}</Property_Ref_No>
  <Property_Status>${status}</Property_Status>
  <Property_purpose>${s.purpose === "sale" ? "Buy" : "Rent"}</Property_purpose>
  <Property_Type>${xml(s.property.type)}</Property_Type>
  <Property_Title>${xml(s.title)}</Property_Title>
  <Property_Description>${xml(s.description)}</Property_Description>
  <Price>${s.price}</Price>
  <Currency>${xml(s.currency)}</Currency>
  <Bedrooms>${s.property.bedrooms ?? ""}</Bedrooms>
  <Bathrooms>${s.property.bathrooms ?? ""}</Bathrooms>
  <Property_Size>${s.property.areaSqft ?? ""}</Property_Size>
  <Property_Size_Unit>SQFT</Property_Size_Unit>
  <City>${xml(s.location.city)}</City>
  <Locality>${xml(s.location.community)}</Locality>
  <Building>${xml(s.location.building)}</Building>
  <Off_plan>${s.location.offPlan ? "Yes" : "No"}</Off_plan>
  <Permit_Number>${xml(s.permit?.number)}</Permit_Number>
  <Listing_Agent>${xml(s.agent.name)}</Listing_Agent>
  <Listing_Agent_Email>${xml(s.agent.email)}</Listing_Agent_Email>
  <Images>${s.media.filter((m) => m.kind === "image").map((m) => `<Image>${xml(m.key)}</Image>`).join("")}</Images>
</Property>`;
    return { format: "xml", payload: body };
  },
};

/** Property Finder-style JSON item (same caveat as above: illustrative mapping pending partner documentation). */
export const propertyFinderProvider: ListingPortalProvider = {
  code: "property_finder",
  label: "Property Finder (JSON export)",
  transform(s, action) {
    return {
      format: "json",
      payload: JSON.stringify({
        reference: s.reference, action, offering_type: s.purpose === "sale" ? "sale" : "rent", property_type: s.property.type,
        title: s.title, description: s.description, price: { value: s.price, currency: s.currency },
        bedrooms: s.property.bedrooms, bathrooms: s.property.bathrooms, size_sqft: s.property.areaSqft,
        location: { city: s.location.city, community: s.location.community, building: s.location.building },
        permit_number: s.permit?.number ?? null, agent: { name: s.agent.name, email: s.agent.email },
        images: s.media.filter((m) => m.kind === "image").sort((a, b) => a.position - b.position).map((m) => m.key),
      }),
    };
  },
};

registerPortalProvider(bayutProvider);
registerPortalProvider(propertyFinderProvider);
