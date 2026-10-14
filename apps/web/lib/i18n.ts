import { cookies } from "next/headers";
import { LANG_COOKIE, type Lang } from "./i18n-dictionary";

export * from "./i18n-dictionary";

export async function getLang(): Promise<Lang> {
  return (await cookies()).get(LANG_COOKIE)?.value === "ar" ? "ar" : "en";
}
