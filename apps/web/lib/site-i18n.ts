export type SiteLang = "en" | "ar";

const T = {
  buy: { en: "Buy", ar: "شراء" }, rent: { en: "Rent", ar: "إيجار" }, search: { en: "Search", ar: "بحث" }, searchPlaceholder: { en: "Area, building or reference", ar: "المنطقة أو المبنى أو الرقم المرجعي" },
  allTypes: { en: "All types", ar: "كل الأنواع" }, allAreas: { en: "All areas", ar: "كل المناطق" }, anyBeds: { en: "Any bedrooms", ar: "أي عدد غرف" }, studio: { en: "Studio", ar: "استوديو" },
  minPrice: { en: "Min price", ar: "أدنى سعر" }, maxPrice: { en: "Max price", ar: "أعلى سعر" }, sort: { en: "Sort", ar: "ترتيب" }, newest: { en: "Newest", ar: "الأحدث" },
  priceLow: { en: "Price: low to high", ar: "السعر: من الأقل" }, priceHigh: { en: "Price: high to low", ar: "السعر: من الأعلى" }, results: { en: "properties", ar: "عقارات" },
  noResults: { en: "No properties match your search.", ar: "لا توجد عقارات مطابقة لبحثك." }, beds: { en: "Beds", ar: "غرف" }, baths: { en: "Baths", ar: "حمامات" }, area: { en: "Area", ar: "المساحة" },
  askPrice: { en: "Price on request", ar: "السعر عند الطلب" }, featured: { en: "Featured", ar: "مميز" }, offPlan: { en: "Off-plan", ar: "على الخارطة" }, perYear: { en: "/ year", ar: "/ سنة" }, perMonth: { en: "/ month", ar: "/ شهر" }, perQuarter: { en: "/ quarter", ar: "/ ربع سنة" },
  details: { en: "Property details", ar: "تفاصيل العقار" }, description: { en: "Description", ar: "الوصف" }, amenities: { en: "Features and amenities", ar: "المزايا والمرافق" }, location: { en: "Location", ar: "الموقع" },
  type: { en: "Type", ar: "النوع" }, furnishing: { en: "Furnishing", ar: "التأثيث" }, parking: { en: "Parking", ar: "المواقف" }, reference: { en: "Reference", ar: "الرقم المرجعي" }, permit: { en: "Permit no.", ar: "رقم التصريح" },
  enquire: { en: "Enquire about this property", ar: "استفسر عن هذا العقار" }, yourName: { en: "Your name", ar: "الاسم" }, phone: { en: "Phone", ar: "الهاتف" }, email: { en: "Email", ar: "البريد الإلكتروني" },
  message: { en: "Message", ar: "الرسالة" }, send: { en: "Send enquiry", ar: "إرسال الاستفسار" }, sent: { en: "Thank you. An agent will contact you shortly.", ar: "شكراً لك. سيتواصل معك أحد الوكلاء قريباً." },
  brochure: { en: "Download brochure", ar: "تحميل الكتيّب" }, video: { en: "Watch video", ar: "مشاهدة الفيديو" }, tour: { en: "Virtual tour", ar: "جولة افتراضية" }, map: { en: "View on map", ar: "عرض على الخريطة" },
  floorplan: { en: "Floor plan", ar: "المخطط" }, gallery: { en: "Photos", ar: "الصور" }, call: { en: "Call", ar: "اتصال" }, whatsapp: { en: "WhatsApp", ar: "واتساب" }, back: { en: "Back to results", ar: "العودة للنتائج" },
  prev: { en: "Previous", ar: "السابق" }, next: { en: "Next", ar: "التالي" }, aboutUs: { en: "About us", ar: "من نحن" }, contactUs: { en: "Contact us", ar: "تواصل معنا" },
  furnished: { en: "Furnished", ar: "مفروش" }, semi_furnished: { en: "Semi-furnished", ar: "نصف مفروش" }, unfurnished: { en: "Unfurnished", ar: "غير مفروش" },
  apartment: { en: "Apartment", ar: "شقة" }, villa: { en: "Villa", ar: "فيلا" }, townhouse: { en: "Townhouse", ar: "تاون هاوس" }, penthouse: { en: "Penthouse", ar: "بنتهاوس" }, office: { en: "Office", ar: "مكتب" }, retail: { en: "Retail", ar: "تجاري" }, land: { en: "Land", ar: "أرض" },
  moreFilters: { en: "More filters", ar: "المزيد من التصفية" }, noPhotos: { en: "Photos coming soon", ar: "الصور قريباً" },
  viewList: { en: "List", ar: "قائمة" }, viewMap: { en: "Map", ar: "خريطة" }, category: { en: "Category", ar: "الفئة" }, allCategories: { en: "All categories", ar: "كل الفئات" },
  cat_residential: { en: "Residential", ar: "سكني" }, cat_commercial: { en: "Commercial", ar: "تجاري" }, cat_land: { en: "Land", ar: "أراضي" },
  subLocation: { en: "Sub location", ar: "المنطقة الفرعية" }, plot: { en: "Plot area", ar: "مساحة الأرض" }, floorNo: { en: "Floor", ar: "الطابق" }, completion: { en: "Completion", ar: "حالة الإنجاز" }, ready: { en: "Ready", ar: "جاهز" },
  ownership: { en: "Ownership", ar: "نوع الملكية" }, freehold: { en: "Freehold", ar: "تملك حر" }, leasehold: { en: "Leasehold", ar: "حق انتفاع" }, usufruct: { en: "Usufruct", ar: "حق منفعة" }, musataha: { en: "Musataha", ar: "مساطحة" },
  yearBuilt: { en: "Year built", ar: "سنة البناء" }, availableFrom: { en: "Available from", ar: "متاح من" }, pricePerSqft: { en: "Price per sqft", ar: "السعر لكل قدم مربع" }, locationTitle: { en: "Location", ar: "الموقع" },
  approxLocation: { en: "Approximate location (community centre)", ar: "موقع تقريبي (وسط المنطقة)" }, utilities: { en: "Utilities", ar: "المرافق" }, included: { en: "Included", ar: "مشمولة" }, notIncluded: { en: "Not included", ar: "غير مشمولة" },
  duplex: { en: "Duplex", ar: "دوبلكس" }, hotel_apartment: { en: "Hotel apartment", ar: "شقة فندقية" }, compound: { en: "Compound", ar: "مجمع" }, full_floor: { en: "Full floor", ar: "طابق كامل" },
  half_floor: { en: "Half floor", ar: "نصف طابق" }, whole_building: { en: "Whole building", ar: "مبنى كامل" }, bulk_units: { en: "Bulk units", ar: "وحدات بالجملة" }, warehouse: { en: "Warehouse", ar: "مستودع" }, showroom: { en: "Showroom", ar: "صالة عرض" },
  labour_camp: { en: "Labour camp", ar: "سكن عمال" }, factory: { en: "Factory", ar: "مصنع" }, farm: { en: "Farm", ar: "مزرعة" }, staff_accommodation: { en: "Staff accommodation", ar: "سكن موظفين" },
  required: { en: "Please give your name and a phone number or email.", ar: "يرجى إدخال الاسم ورقم الهاتف أو البريد الإلكتروني." }, failed: { en: "Something went wrong. Please try again.", ar: "حدث خطأ. يرجى المحاولة مرة أخرى." },
} as const;

export type SiteKey = keyof typeof T;
export const st = (lang: SiteLang, key: SiteKey): string => T[key][lang];
export const stDyn = (lang: SiteLang, key: string): string => (T as Record<string, { en: string; ar: string }>)[key]?.[lang] ?? key.replace(/_/g, " ");
export const pickLang = (q: string | undefined, fallback: SiteLang): SiteLang => (q === "ar" || q === "en" ? q : fallback);
export const SQFT_PER_SQM = 10.7639;
export const area = (sqft: number | null, unit: "sqft" | "sqm", lang: SiteLang) => (sqft == null ? "-" : unit === "sqm" ? `${Math.round(sqft / SQFT_PER_SQM).toLocaleString(lang === "ar" ? "ar-AE" : "en-US")} m²` : `${Math.round(sqft).toLocaleString(lang === "ar" ? "ar-AE" : "en-US")} sqft`);
export const price = (n: number | null, currency: string, lang: SiteLang, freq: string | null, purpose: string) => {
  if (n == null) return st(lang, "askPrice");
  const base = `${currency} ${n.toLocaleString(lang === "ar" ? "ar-AE" : "en-US")}`;
  return purpose === "rent" ? `${base} ${freq === "monthly" ? st(lang, "perMonth") : freq === "quarterly" ? st(lang, "perQuarter") : st(lang, "perYear")}` : base;
};
