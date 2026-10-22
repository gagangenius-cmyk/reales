/** Small dependency-free SVG/CSS charts (server-rendered). Colours come from the theme tokens so dark mode works. */

const fmt = (n: number) => n.toLocaleString("en-US");

export function BarList({ data, unit = "", color = "var(--accent)" }: { data: { label: string; value: number; hint?: string }[]; unit?: string; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (data.length === 0) return <p className="muted text-sm">No data yet.</p>;
  return (
    <ul className="flex flex-col gap-2.5" role="list">
      {data.map((d) => (
        <li key={d.label} className="text-sm">
          <div className="mb-1 flex items-baseline justify-between gap-3"><span className="truncate">{d.label}</span><span className="font-semibold tabular-nums">{fmt(d.value)}{unit}{d.hint && <span className="muted ml-2 text-xs font-normal">{d.hint}</span>}</span></div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--card-2)" }} role="img" aria-label={`${d.label}: ${d.value}`}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Funnel({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ol className="flex flex-col gap-1.5">
      {data.map((d, i) => (
        <li key={d.label} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 truncate text-right muted">{d.label}</span>
          <div className="relative h-8 flex-1 overflow-hidden rounded-md" style={{ background: "var(--card-2)" }}>
            <div className="flex h-full items-center rounded-md px-3 font-semibold text-white" style={{ width: `${Math.max(6, (d.value / max) * 100)}%`, background: `linear-gradient(90deg, var(--accent), var(--accent-2))`, opacity: 1 - i * 0.08 }}>{fmt(d.value)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Column chart with labels under each bar (weekly intake). */
export function Columns({ data, height = 140 }: { data: { label: string; value: number }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(1, data.length);
  return (
    <svg viewBox={`0 0 100 ${height / 2 + 14}`} className="w-full" role="img" aria-label="Leads per week" preserveAspectRatio="none" style={{ height: height + 28 }}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height / 2);
        return (
          <g key={d.label + i}>
            <rect x={i * w + w * 0.15} y={height / 2 - h} width={w * 0.7} height={Math.max(h, d.value ? 1 : 0)} rx="1" fill="var(--accent)" opacity={0.35 + 0.65 * (i / Math.max(1, data.length - 1))}><title>{`${d.label}: ${d.value}`}</title></rect>
            <text x={i * w + w / 2} y={height / 2 + 7} fontSize="3" textAnchor="middle" fill="var(--muted)">{i % 2 === 0 ? d.label : ""}</text>
            {d.value > 0 && <text x={i * w + w / 2} y={height / 2 - h - 1.5} fontSize="3" textAnchor="middle" fill="var(--fg)">{d.value}</text>}
          </g>
        );
      })}
    </svg>
  );
}

const PALETTE = ["#4f46e5", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#64748b"];
export function Donut({ data, center }: { data: { label: string; value: number }[]; center?: string }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const r = 15.9155;
  let offset = 25;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox="0 0 42 42" className="h-36 w-36 shrink-0" role="img" aria-label="Breakdown">
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--card-2)" strokeWidth="6" />
        {total > 0 && data.map((d, i) => {
          const pct = (d.value / total) * 100;
          const el = <circle key={d.label} cx="21" cy="21" r={r} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="6" strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={offset}><title>{`${d.label}: ${d.value}`}</title></circle>;
          offset -= pct;
          return el;
        })}
        <text x="21" y="22.5" textAnchor="middle" fontSize="6" fontWeight="700" fill="var(--fg)">{center ?? fmt(total)}</text>
      </svg>
      <ul className="flex flex-col gap-1.5 text-sm">
        {data.map((d, i) => <li key={d.label} className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} /><span className="capitalize">{d.label}</span><span className="muted tabular-nums">{fmt(d.value)}</span></li>)}
      </ul>
    </div>
  );
}
