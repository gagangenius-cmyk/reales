"use client";

import { Progress, Tag } from "antd";

interface Row { id: string; label: string; target: number; actual: number; pct: number; expectedPct: number; status: "ahead" | "on_track" | "behind" | "achieved" }
const color: Record<Row["status"], string> = { achieved: "green", ahead: "green", on_track: "blue", behind: "red" };
const stroke: Record<Row["status"], string> = { achieved: "#059669", ahead: "#059669", on_track: "#4f46e5", behind: "#dc2626" };
const n = (v: number) => Math.round(v).toLocaleString("en-US");

/** Target progress bars. The marker text shows how far through the period we are, so "behind" is visible at a glance. */
export function TargetBars({ rows }: { rows: Row[] }) {
  return (
    <ul className="flex flex-col gap-4">{rows.map((r) => (
      <li key={r.id}>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium capitalize">{r.label}</span><span><b>{n(r.actual)}</b> <span className="muted">of {n(r.target)}</span> <Tag color={color[r.status]} style={{ marginInlineStart: 6 }}>{r.status.replace("_", " ")}</Tag></span></div>
        <Progress percent={Math.min(100, Math.round(r.pct))} success={{ percent: 0 }} strokeColor={stroke[r.status]} showInfo={false} />
        <p className="muted text-xs">{Math.round(r.pct)}% done, {Math.round(r.expectedPct)}% of the period has passed</p>
      </li>))}</ul>
  );
}
