/**
 * The amenity and feature catalogue shared by the listing screen, the public website and every portal feed.
 * `code` is our stable key (stored on the listing). `pf` is the code Property Finder's XML feed commonly uses, where we are confident of it;
 * portals not listed here receive the English label instead. Always check the mapping against the portal's current documentation.
 */
export interface Amenity { code: string; label: string; labelAr: string; group: AmenityGroup; pf?: string }
export type AmenityGroup = "interior" | "building" | "community" | "outdoor" | "security" | "services";

export const AMENITY_GROUPS: { key: AmenityGroup; label: string; labelAr: string }[] = [
  { key: "interior", label: "Interior", labelAr: "الداخل" },
  { key: "outdoor", label: "Outdoor and views", labelAr: "الخارج والإطلالات" },
  { key: "building", label: "Building facilities", labelAr: "مرافق المبنى" },
  { key: "community", label: "Community", labelAr: "المجتمع" },
  { key: "security", label: "Security and safety", labelAr: "الأمن والسلامة" },
  { key: "services", label: "Services", labelAr: "الخدمات" },
];

export const AMENITIES: Amenity[] = [
  { code: "central_ac", label: "Central A/C", labelAr: "تكييف مركزي", group: "interior", pf: "AC" },
  { code: "built_in_wardrobes", label: "Built-in wardrobes", labelAr: "خزائن مدمجة", group: "interior", pf: "BW" },
  { code: "kitchen_appliances", label: "Kitchen appliances", labelAr: "أجهزة المطبخ", group: "interior", pf: "BK" },
  { code: "walk_in_closet", label: "Walk-in closet", labelAr: "غرفة ملابس", group: "interior", pf: "WC" },
  { code: "maids_room", label: "Maid's room", labelAr: "غرفة خادمة", group: "interior", pf: "MR" },
  { code: "study", label: "Study room", labelAr: "غرفة دراسة", group: "interior" },
  { code: "laundry_room", label: "Laundry room", labelAr: "غرفة غسيل", group: "interior" },
  { code: "storage_room", label: "Storage room", labelAr: "غرفة تخزين", group: "interior" },
  { code: "fireplace", label: "Fireplace", labelAr: "مدفأة", group: "interior" },
  { code: "smart_home", label: "Smart home", labelAr: "منزل ذكي", group: "interior" },
  { code: "balcony", label: "Balcony", labelAr: "شرفة", group: "outdoor", pf: "BA" },
  { code: "terrace", label: "Terrace", labelAr: "تراس", group: "outdoor" },
  { code: "private_garden", label: "Private garden", labelAr: "حديقة خاصة", group: "outdoor", pf: "PG" },
  { code: "private_pool", label: "Private pool", labelAr: "مسبح خاص", group: "outdoor", pf: "PY" },
  { code: "private_jacuzzi", label: "Private jacuzzi", labelAr: "جاكوزي خاص", group: "outdoor" },
  { code: "bbq_area", label: "BBQ area", labelAr: "منطقة شواء", group: "outdoor" },
  { code: "view_of_water", label: "View of water", labelAr: "إطلالة على الماء", group: "outdoor", pf: "VW" },
  { code: "view_of_landmark", label: "View of landmark", labelAr: "إطلالة على معلم", group: "outdoor", pf: "VL" },
  { code: "city_view", label: "City view", labelAr: "إطلالة على المدينة", group: "outdoor" },
  { code: "park_view", label: "Park or garden view", labelAr: "إطلالة على حديقة", group: "outdoor" },
  { code: "shared_pool", label: "Shared pool", labelAr: "مسبح مشترك", group: "building", pf: "SP" },
  { code: "shared_gym", label: "Shared gym", labelAr: "نادي رياضي مشترك", group: "building", pf: "SG" },
  { code: "shared_spa", label: "Shared spa", labelAr: "سبا مشترك", group: "building", pf: "SS" },
  { code: "covered_parking", label: "Covered parking", labelAr: "موقف مغطى", group: "building", pf: "CP" },
  { code: "visitor_parking", label: "Visitor parking", labelAr: "موقف زوار", group: "building" },
  { code: "children_play_area", label: "Children's play area", labelAr: "منطقة ألعاب أطفال", group: "building", pf: "CA" },
  { code: "business_center", label: "Business centre", labelAr: "مركز أعمال", group: "building", pf: "BC" },
  { code: "lobby", label: "Lobby in building", labelAr: "ردهة المبنى", group: "building" },
  { code: "sauna_steam", label: "Sauna or steam room", labelAr: "ساونا أو بخار", group: "building" },
  { code: "tennis_squash", label: "Tennis or squash court", labelAr: "ملعب تنس أو اسكواش", group: "community" },
  { code: "jogging_track", label: "Jogging or cycling track", labelAr: "مسار جري ودراجات", group: "community" },
  { code: "near_metro", label: "Near metro", labelAr: "قرب المترو", group: "community" },
  { code: "near_school", label: "Near schools", labelAr: "قرب المدارس", group: "community" },
  { code: "near_supermarket", label: "Near supermarket", labelAr: "قرب السوبرماركت", group: "community" },
  { code: "near_hospital", label: "Near hospital", labelAr: "قرب مستشفى", group: "community" },
  { code: "beach_access", label: "Beach access", labelAr: "وصول إلى الشاطئ", group: "community" },
  { code: "pets_allowed", label: "Pets allowed", labelAr: "يسمح بالحيوانات الأليفة", group: "community", pf: "PA" },
  { code: "security_24h", label: "24-hour security", labelAr: "أمن على مدار الساعة", group: "security", pf: "SE" },
  { code: "cctv", label: "CCTV", labelAr: "كاميرات مراقبة", group: "security" },
  { code: "gated_community", label: "Gated community", labelAr: "مجمع مسور", group: "security" },
  { code: "fire_alarm", label: "Fire alarm and sprinklers", labelAr: "إنذار حريق ورشاشات", group: "security" },
  { code: "concierge", label: "Concierge service", labelAr: "خدمة الكونسيرج", group: "services", pf: "CS" },
  { code: "maintenance_service", label: "Maintenance service", labelAr: "خدمة صيانة", group: "services" },
  { code: "cleaning_service", label: "Cleaning service", labelAr: "خدمة تنظيف", group: "services" },
  { code: "waste_disposal", label: "Waste disposal", labelAr: "التخلص من النفايات", group: "services" },
  { code: "broadband", label: "Broadband ready", labelAr: "جاهز للإنترنت", group: "services" },
  { code: "satellite_cable", label: "Satellite or cable TV", labelAr: "قنوات فضائية أو كابل", group: "services" },
];

const BY_CODE = new Map(AMENITIES.map((a) => [a.code, a]));
export const amenityLabel = (code: string, lang: "en" | "ar" = "en") => { const a = BY_CODE.get(code); return a ? (lang === "ar" ? a.labelAr : a.label) : code.replace(/_/g, " "); };
/** Keep only known codes (free-text extras are allowed elsewhere, not here), without duplicates. */
export const cleanAmenities = (codes: unknown): string[] => [...new Set((Array.isArray(codes) ? codes : []).map(String).filter((c) => BY_CODE.has(c)))];
export const pfAmenityCodes = (codes: string[]) => codes.map((c) => BY_CODE.get(c)?.pf).filter((x): x is string => !!x);
