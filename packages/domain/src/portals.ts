import { createHash } from "node:crypto";
import { canonicalJson } from "@reales/database";
import { AMENITIES } from "./amenities";

const AMENITY_PF = new Map(AMENITIES.filter((a) => a.pf).map((a) => [a.code, a.pf!]));

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
  location: { building: string; community: string | null; subCommunity?: string | null; city: string | null; country?: string; project: string; offPlan: boolean; projectRegistrationNo: string | null; bayutLocationId?: string | null; pfLocationId?: string | null };
  agent: { name: string | null; email: string | null; licenceNo: string | null };
  brokerage: { name: string | null; licenceNo: string | null };
  permit: { number: string; authority: string; expiresAt: string } | null;
  media: Array<{ kind: string; key: string; position: number; id?: string; caption?: string | null; url?: string | null }>;
  /** Marketing detail. Optional so older snapshots (stored before these existed) still type-check. */
  details?: {
    features: string[]; furnishing: string | null; parkingSpaces: number | null; rentFrequency: string | null; cheques: number | null; securityDeposit: number | null; serviceCharge: number | null;
    videoUrl: string | null; virtualTourUrl: string | null; titleAr: string | null; descriptionAr: string | null; latitude: number | null; longitude: number | null;
    completionStatus: "ready" | "off_plan"; ownership?: string | null; yearBuilt?: number | null; availableFrom?: string | null; utilitiesIncluded?: boolean | null; plotAreaSqft?: number | null; pricePerSqft?: number | null; agentPhone: string | null; agentPhotoUrl: string | null; exclusivity: string; featured: boolean;
  };
  capturedAt: string;
}

export type PortalAction = "publish" | "update" | "unpublish";
export interface PortalPayload { format: "xml" | "json"; payload: string }

/** Every portal implements this; domain code never branches on a portal name. */
export interface ListingPortalProvider {
  readonly code: string;
  readonly label: string;
  transform(snapshot: CanonicalListing, action: PortalAction): PortalPayload;
  /** Wrap already-transformed items into the document a portal pulls from a public URL. */
  wrapFeed?(items: string[], meta: { generatedAt: string }): { contentType: string; body: string };
}

const registry = new Map<string, ListingPortalProvider>();
export const registerPortalProvider = (p: ListingPortalProvider) => void registry.set(p.code, p);
export const getPortalProvider = (code: string) => registry.get(code) ?? null;
export const listPortalProviders = () => [...registry.values()].map((p) => ({ code: p.code, label: p.label }));

export const snapshotHash = (s: unknown) => createHash("sha256").update(canonicalJson(s)).digest("hex");

const xml = (v: unknown) => String(v ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

const yn = (v: boolean) => (v ? "Yes" : "No");
const photos = (s: CanonicalListing) => s.media.filter((m) => m.kind === "image").sort((a, b) => a.position - b.position).filter((m) => m.url);
const plans = (s: CanonicalListing) => s.media.filter((m) => m.kind === "floorplan" && m.url);
const PROPERTY_TYPE_PF: Record<string, string> = { apartment: "AP", studio: "AP", villa: "VH", townhouse: "TH", penthouse: "PH", duplex: "DX", hotel_apartment: "HA", compound: "CD", full_floor: "FF", half_floor: "HF", whole_building: "WB", bulk_units: "BU", office: "OF", retail: "RE", showroom: "SH", warehouse: "WH", factory: "FA", farm: "FM", labour_camp: "LC", staff_accommodation: "SA", land: "LP" };
/** Readable property type for feeds that take names (Bayut style): "hotel_apartment" -> "Hotel Apartment". */
const typeName = (t: string) => ({ bulk_units: "Bulk Sale Unit", labour_camp: "Labour Camp" } as Record<string, string>)[t] ?? t.split("_").map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
const FURNISHED_PF: Record<string, string> = { furnished: "Yes", semi_furnished: "Partly", unfurnished: "No" };
const RENT_PERIOD: Record<string, string> = { yearly: "Y", quarterly: "Q", monthly: "M" };

/**
 * Bayut / dubizzle XML item. Bayut polls a public feed URL and gives each agency its XML documentation privately (support@bayut.com),
 * so these tag names are a best-effort mapping, NOT a verified contract. Validate against the document Bayut sends you before going live;
 * every tag lives in this one function so adjusting it is a small change.
 */
export const bayutProvider: ListingPortalProvider = {
  code: "bayut",
  label: "Bayut / dubizzle (XML feed)",
  transform(s, action) {
    const d = s.details;
    const status = action === "unpublish" ? "deleted" : "live";
    const body = `<Property>
  <Property_Ref_No>${xml(s.reference)}</Property_Ref_No>
  <Property_Status>${status}</Property_Status>
  <Property_purpose>${s.purpose === "sale" ? "Buy" : "Rent"}</Property_purpose>
  <Property_Type>${xml(typeName(s.property.type))}</Property_Type>
  <Property_Title>${xml(s.title)}</Property_Title>
  <Property_Title_AR>${xml(d?.titleAr)}</Property_Title_AR>
  <Property_Description>${xml(s.description)}</Property_Description>
  <Property_Description_AR>${xml(d?.descriptionAr)}</Property_Description_AR>
  <Price>${s.price}</Price>
  <Currency>${xml(s.currency)}</Currency>
  <Rent_Frequency>${xml(d?.rentFrequency)}</Rent_Frequency>
  <Bedrooms>${s.property.bedrooms ?? ""}</Bedrooms>
  <Bathrooms>${s.property.bathrooms ?? ""}</Bathrooms>
  <Property_Size>${s.property.areaSqft ?? ""}</Property_Size>
  <Property_Size_Unit>SQFT</Property_Size_Unit>
  <Plot_Size>${d?.plotAreaSqft ?? ""}</Plot_Size>
  <Price_Per_Sqft>${d?.pricePerSqft ?? ""}</Price_Per_Sqft>
  <Completion_Status>${xml(d?.completionStatus)}</Completion_Status>
  <Ownership>${xml(d?.ownership)}</Ownership>
  <Year_Built>${d?.yearBuilt ?? ""}</Year_Built>
  <Available_From>${xml(d?.availableFrom)}</Available_From>
  <Utilities_Included>${d?.utilitiesIncluded == null ? "" : yn(d.utilitiesIncluded)}</Utilities_Included>
  <Furnished>${xml(d?.furnishing ? FURNISHED_PF[d.furnishing] : "")}</Furnished>
  <Parking>${d?.parkingSpaces ?? ""}</Parking>
  <Country>${xml(s.location.country ?? "AE")}</Country>
  <City>${xml(s.location.city)}</City>
  <Locality>${xml(s.location.community)}</Locality>
  <Sub_Locality>${xml(s.location.subCommunity)}</Sub_Locality>
  <Location_Id>${xml(s.location.pfLocationId)}</Location_Id>
  <Building>${xml(s.location.building)}</Building>
  <Latitude>${d?.latitude ?? ""}</Latitude>
  <Longitude>${d?.longitude ?? ""}</Longitude>
  <Off_plan>${yn(s.location.offPlan)}</Off_plan>
  <Permit_Number>${xml(s.permit?.number)}</Permit_Number>
  <Features>${(d?.features ?? []).map((f) => `<Feature>${xml(f)}</Feature>`).join("")}</Features>
  <Listing_Agent>${xml(s.agent.name)}</Listing_Agent>
  <Listing_Agent_Email>${xml(s.agent.email)}</Listing_Agent_Email>
  <Listing_Agent_Phone>${xml(d?.agentPhone)}</Listing_Agent_Phone>
  <Images>${photos(s).map((m) => `<Image>${xml(m.url)}</Image>`).join("")}</Images>
  <Floor_Plans>${plans(s).map((m) => `<Floor_Plan>${xml(m.url)}</Floor_Plan>`).join("")}</Floor_Plans>
  <Video_Url>${xml(d?.videoUrl)}</Video_Url>
  <Virtual_Tour_Url>${xml(d?.virtualTourUrl)}</Virtual_Tour_Url>
</Property>`;
    return { format: "xml", payload: body };
  },
  wrapFeed: (items, meta) => ({ contentType: "application/xml; charset=utf-8", body: `<?xml version="1.0" encoding="UTF-8"?>\n<Properties last_update="${meta.generatedAt}" count="${items.length}">\n${items.join("\n")}\n</Properties>` }),
};

/**
 * Property Finder XML item (the widely used "Property Finder XML" shape: offering_type RS/RR/CS/CR, property_type AP/VH/TH/PH..., amenity codes).
 * Same caveat: confirm against Property Finder's current feed specification, and note that their Enterprise API is the alternative to this feed.
 */
export const propertyFinderProvider: ListingPortalProvider = {
  code: "property_finder",
  label: "Property Finder (XML feed / API)",
  transform(s, action) {
    const d = s.details;
    const pfCodes = (d?.features ?? []).map((f) => AMENITY_PF.get(f)).filter(Boolean).join(",");
    const body = `<property last_update="${s.capturedAt.slice(0, 19).replace("T", " ")}" id="${xml(s.listingId)}">
  <reference_number>${xml(s.reference)}</reference_number>
  <status>${action === "unpublish" ? "deleted" : "live"}</status>
  <permit_number>${xml(s.permit?.number)}</permit_number>
  <offering_type>${s.purpose === "sale" ? (s.location.offPlan ? "RS" : "RS") : "RR"}</offering_type>
  <property_type>${PROPERTY_TYPE_PF[s.property.type] ?? "AP"}</property_type>
  <price>${s.price}</price>
  <rental_period>${s.purpose === "rent" ? RENT_PERIOD[d?.rentFrequency ?? "yearly"] ?? "Y" : ""}</rental_period>
  <cheques>${d?.cheques ?? ""}</cheques>
  <size>${s.property.areaSqft ?? ""}</size>
  <bedroom>${s.property.bedrooms ?? ""}</bedroom>
  <bathroom>${s.property.bathrooms ?? ""}</bathroom>
  <title_en>${xml(s.title)}</title_en>
  <title_ar>${xml(d?.titleAr)}</title_ar>
  <description_en>${xml(s.description)}</description_en>
  <description_ar>${xml(d?.descriptionAr)}</description_ar>
  <city>${xml(s.location.city)}</city>
  <community>${xml(s.location.community)}</community>
  <sub_community>${xml(s.location.subCommunity)}</sub_community>
  <location_id>${xml(s.location.pfLocationId)}</location_id>
  <country>${xml(s.location.country ?? "AE")}</country>
  <plot_size>${d?.plotAreaSqft ?? ""}</plot_size>
  <price_per_sqft>${d?.pricePerSqft ?? ""}</price_per_sqft>
  <ownership>${xml(d?.ownership)}</ownership>
  <build_year>${d?.yearBuilt ?? ""}</build_year>
  <available_from>${xml(d?.availableFrom)}</available_from>
  <utilities_included>${d?.utilitiesIncluded == null ? "" : d.utilitiesIncluded ? "Yes" : "No"}</utilities_included>
  <property_name>${xml(s.location.building)}</property_name>
  <furnished>${xml(d?.furnishing ? FURNISHED_PF[d.furnishing] : "")}</furnished>
  <parking>${d?.parkingSpaces ?? ""}</parking>
  <geopoints>${d?.latitude != null && d?.longitude != null ? `${d.latitude},${d.longitude}` : ""}</geopoints>
  <completion_status>${(d?.completionStatus ?? (s.location.offPlan ? "off_plan" : "ready")) === "off_plan" ? "off_plan" : "completed"}</completion_status>
  <private_amenities>${pfCodes}</private_amenities>
  <video_tour_url>${xml(d?.videoUrl)}</video_tour_url>
  <view360>${xml(d?.virtualTourUrl)}</view360>
  <photo>${photos(s).map((m) => `<url last_updated="${s.capturedAt.slice(0, 19).replace("T", " ")}">${xml(m.url)}</url>`).join("")}</photo>
  <floor_plan>${plans(s).map((m) => `<url>${xml(m.url)}</url>`).join("")}</floor_plan>
  <agent><id>${xml(s.agent.email)}</id><name>${xml(s.agent.name)}</name><email>${xml(s.agent.email)}</email><phone>${xml(d?.agentPhone)}</phone><license_no>${xml(s.agent.licenceNo)}</license_no></agent>
</property>`;
    return { format: "xml", payload: body };
  },
  wrapFeed: (items, meta) => ({ contentType: "application/xml; charset=utf-8", body: `<?xml version="1.0" encoding="UTF-8"?>\n<list last_update="${meta.generatedAt.slice(0, 19).replace("T", " ")}" listing_count="${items.length}">\n${items.join("\n")}\n</list>` }),
};

registerPortalProvider(bayutProvider);
registerPortalProvider(propertyFinderProvider);
