/** Lower-cased, trimmed email, or null when it is not a plausible address. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
}

/**
 * Normalise a phone number to E.164. Understands UAE local formats (05x xxx xxxx, 00971..., +971...).
 * Returns null when the number cannot be interpreted; callers must treat that as invalid, not guess.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountryCode = "971"): string | null {
  if (!raw) return null;
  let v = raw.trim().replace(/[\s().-]/g, "");
  if (v.startsWith("00")) v = "+" + v.slice(2);
  if (!v.startsWith("+")) {
    if (/^0\d{8,9}$/.test(v)) v = "+" + defaultCountryCode + v.slice(1); // national format with trunk 0
    else if (v.startsWith(defaultCountryCode) && v.length >= 11) v = "+" + v;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
}
