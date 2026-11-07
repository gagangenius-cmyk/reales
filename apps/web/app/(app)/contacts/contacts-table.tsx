"use client";

import Link from "next/link";
import { Avatar, Tag } from "antd";
import { DataTable } from "@/components/data-table";

interface Row { id: string; name: string; type: string; phone: string | null; email: string | null; nationality: string | null; channel: string | null; tags: string[] }
const hue = (s: string) => ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed", "#2563eb"][[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 7];

export function ContactsTable({ rows }: { rows: Row[] }) {
  return (
    <DataTable<Row> rows={rows} paging={false} empty="No contacts visible to you." columns={[
      { title: "Name", dataIndex: "name", sorter: (a, b) => a.name.localeCompare(b.name), render: (_, r) => (
        <Link href={`/contacts/${r.id}`} className="flex items-center gap-2 font-medium"><Avatar size={30} style={{ background: hue(r.name), flexShrink: 0 }}>{(r.name[0] ?? "?").toUpperCase()}</Avatar>{r.name}{r.type === "company" && <Tag>company</Tag>}</Link>) },
      { title: "Phone", dataIndex: "phone", render: (v: string | null) => v ?? "-" },
      { title: "Email", dataIndex: "email", render: (v: string | null) => v ?? "-" },
      { title: "Nationality", dataIndex: "nationality", render: (v: string | null) => v ?? "-" },
      { title: "Prefers", dataIndex: "channel", render: (v: string | null) => (v ? <Tag color="cyan">{v}</Tag> : "-") },
      { title: "Tags", dataIndex: "tags", render: (t: string[]) => t.slice(0, 3).map((x) => <Tag key={x} color="purple">{x}</Tag>) },
      { title: "", key: "open", align: "right", render: (_, r) => <Link className="btn-ghost text-xs" href={`/contacts/${r.id}`}>Open</Link> },
    ]} />
  );
}
