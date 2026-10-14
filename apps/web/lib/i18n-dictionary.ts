export type Lang = "en" | "ar";
export const LANG_COOKIE = "reales_lang";

/**
 * Interface strings that are translated so far: navigation, sign-in and the owner/tenant portal chrome. Everything else is still English
 * (the layout flips to right-to-left for Arabic, but page content is not yet translated). The Arabic below is a first draft and needs review by a native speaker.
 */
export const AR: Record<string, string> = {
  Notifications: "الإشعارات", Dashboard: "لوحة التحكم", Calendar: "التقويم", Tasks: "المهام", Leads: "العملاء المحتملون", Contacts: "جهات الاتصال", Inventory: "المخزون", Listings: "الإعلانات",
  Viewings: "المعاينات", Inbox: "صندوق الوارد", Templates: "القوالب", Campaigns: "الحملات", Bots: "الروبوتات", Automation: "الأتمتة", Deals: "الصفقات", Finance: "المالية",
  Portfolios: "المحافظ العقارية", Leases: "عقود الإيجار", Maintenance: "الصيانة", Inspections: "الفحوصات", Compliance: "الامتثال", "Saved searches": "عمليات البحث المحفوظة", Valuation: "التقييم",
  Referrals: "الإحالات", Projects: "المشاريع", Organization: "المؤسسة", "Portal access": "وصول البوابة", "Import / export": "استيراد / تصدير", Users: "المستخدمون", Settings: "الإعدادات", "Audit log": "سجل التدقيق",
  "Sign out": "تسجيل الخروج", "Sign in": "تسجيل الدخول", Workspace: "مساحة العمل", Email: "البريد الإلكتروني", Password: "كلمة المرور", Continue: "متابعة", Verify: "تحقق",
  "Sign in with single sign-on": "تسجيل الدخول الموحد (SSO)", "Forgot your password?": "هل نسيت كلمة المرور؟", "Please wait...": "الرجاء الانتظار...",
  "Reales CRM for UAE real estate": "نظام Reales لإدارة العقارات في الإمارات", "Authenticator code or recovery code": "رمز المصادقة أو رمز الاسترداد",
  "Property owner portal": "بوابة مالك العقار", "Tenant portal": "بوابة المستأجر", "Your leases": "عقودك", Statements: "الكشوفات", "Maintenance requests": "طلبات الصيانة",
  "Report a maintenance problem": "الإبلاغ عن مشكلة صيانة", "Send request": "إرسال الطلب", Welcome: "مرحباً",
};

export const translate = (lang: Lang, s: string) => (lang === "ar" ? AR[s] ?? s : s);

