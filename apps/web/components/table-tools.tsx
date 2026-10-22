"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const val = (td: Element | undefined) => (td?.textContent ?? "").trim();
function key(text: string): number | string {
  const t = text.replace(/\s+/g, " ");
  const d = Date.parse(t);
  if (/\d{1,2}[ /-][A-Za-z]{3,}|\d{4}-\d{2}-\d{2}/.test(t) && !Number.isNaN(d)) return d;
  const n = Number(t.replace(/[^\d.\-]/g, ""));
  if (/^[^\d-]*-?[\d,]+(\.\d+)?\D{0,12}$/.test(t) && t !== "" && Number.isFinite(n)) return n;
  return t.toLowerCase();
}

/**
 * Gives every list table two things without each page having to ask: click a column heading to sort (rows on the page), and a small box that filters the
 * visible rows as you type. Pages with their own server-side search and sort (Listings, Leads) are left alone because those query the database.
 */
export function TableTools() {
  const path = usePathname();
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    for (const table of Array.from(document.querySelectorAll<HTMLTableElement>("main table.t"))) {
      if (table.dataset.tools || table.closest("[data-server-table]")) continue;
      const head = table.tHead?.rows[0], body = table.tBodies[0];
      if (!head || !body || body.rows.length < 2) continue;
      if (head.querySelector("th a[href]")) continue; // server-sorted headings
      table.dataset.tools = "1";
      let dir = 1, col = -1;
      const ths = Array.from(head.cells);
      ths.forEach((th, i) => {
        if (!th.textContent?.trim() || th.querySelector("input,button,select")) return;
        th.style.cursor = "pointer"; th.setAttribute("aria-sort", "none"); th.title = "Click to sort"; th.tabIndex = 0;
        const sort = () => {
          dir = col === i ? -dir : 1; col = i;
          ths.forEach((o) => { if (o.hasAttribute("aria-sort")) o.setAttribute("aria-sort", "none"); o.querySelector(".ts-ind")?.remove(); });
          th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
          const ind = document.createElement("span"); ind.className = "ts-ind"; ind.setAttribute("aria-hidden", "true"); ind.textContent = dir === 1 ? " ▲" : " ▼"; th.appendChild(ind);
          const rows = Array.from(body.rows).filter((r) => r.cells.length === ths.length);
          rows.sort((a, b) => { const x = key(val(a.cells[i])), y = key(val(b.cells[i])); return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir; });
          for (const r of rows) body.appendChild(r);
        };
        th.addEventListener("click", sort);
        th.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") { e.preventDefault(); sort(); } });
      });
      if (body.rows.length >= 8) {
        const box = document.createElement("input");
        box.type = "search"; box.placeholder = "Filter these rows"; box.className = "input"; box.setAttribute("aria-label", "Filter rows in this table"); box.style.cssText = "max-width:18rem;margin:0 0 .5rem";
        const holder = table.parentElement!;
        holder.parentElement?.insertBefore(box, holder);
        box.addEventListener("input", () => {
          const q = box.value.trim().toLowerCase();
          for (const r of Array.from(body.rows)) r.style.display = !q || (r.textContent ?? "").toLowerCase().includes(q) ? "" : "none";
        });
        cleanups.push(() => box.remove());
      }
      cleanups.push(() => { delete table.dataset.tools; });
    }
    return () => { for (const c of cleanups) c(); };
  }, [path]);
  return null;
}
