"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Search box for a server-rendered table. Typing re-queries the database (the page reads `?q=`), debounced so each keystroke does not hit it,
 * and keeps every other filter and sort in the URL. The first page is shown again after each change.
 */
export function LiveSearch({ placeholder = "Search", param = "q", name = param }: { placeholder?: string; param?: string; name?: string }) {
  const router = useRouter(), path = usePathname(), params = useSearchParams();
  const [value, setValue] = useState(params.get(param) ?? "");
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { setValue(params.get(param) ?? ""); }, [params, param]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function change(v: string) {
    setValue(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (v.trim()) next.set(param, v.trim()); else next.delete(param);
      next.delete("page");
      start(() => router.replace(`${path}${next.toString() ? `?${next}` : ""}`, { scroll: false }));
    }, 350);
  }
  return <input className="input" type="search" name={name} value={value} onChange={(e) => change(e.target.value)} placeholder={placeholder} aria-label={placeholder} aria-busy={pending} style={pending ? { opacity: 0.7 } : undefined} />;
}
