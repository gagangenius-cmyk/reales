"use client";

import Link from "next/link";
import { Tag } from "antd";
import { DataTable } from "@/components/data-table";

interface Row { id: string; number: number; title: string; status: string; currency: string | null; amount: string; vatAmount: string; itemCount: number; scheduledFor: string | null; createdAt: string }
const color: Record<string, string> = { released: "green", rejected: "red", cancelled: "red", reversed: "red", approved: "blue", scheduled: "blue", verified: "cyan", submitted: "gold", draft: "default" };
const money = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 });

export function ClaimsTable({ rows }: { rows: Row[] }) {
  return (
    <DataTable<Row> rows={rows} searchKeys={["title", "status"]} empty="No claim batches yet." columns={[
      { title: "Batch", dataIndex: "number", sorter: (a, b) => a.number - b.number, defaultSortOrder: "descend", render: (_, r) => <Link href={`/claims/${r.id}`}>#{r.number} {r.title}</Link> },
      { title: "Status", dataIndex: "status", filters: Object.keys(color).map((s) => ({ text: s, value: s })), onFilter: (v, r) => r.status === v, render: (s: string) => <Tag color={color[s]}>{s}</Tag> },
      { title: "Items", dataIndex: "itemCount", sorter: (a, b) => a.itemCount - b.itemCount, align: "right" },
      { title: "Amount", dataIndex: "amount", sorter: (a, b) => Number(a.amount) - Number(b.amount), align: "right", render: (_, r) => `${r.currency ?? ""} ${money(r.amount)}` },
      { title: "VAT", dataIndex: "vatAmount", align: "right", render: (v: string) => money(v) },
      { title: "Release date", dataIndex: "scheduledFor", sorter: (a, b) => String(a.scheduledFor ?? "").localeCompare(String(b.scheduledFor ?? "")), render: (v: string | null) => v ?? "-" },
      { title: "Created", dataIndex: "createdAt", sorter: (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt), render: (v: string) => new Date(v).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric" }) },
    ]} />
  );
}
