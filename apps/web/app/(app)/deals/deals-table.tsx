"use client";

import Link from "next/link";
import { Tag } from "antd";
import { DataTable } from "@/components/data-table";

interface Row { id: string; createdAt: string; dealType: string; stage: string; status: string; amount: number; currency: string }
const statusColor: Record<string, string> = { closed: "green", open: "blue", cancelled: "default", lost: "default" };

export function DealsTable({ rows }: { rows: Row[] }) {
  return (
    <DataTable<Row> rows={rows} paging={false} searchKeys={["stage", "dealType"]} empty="No deals visible to you." columns={[
      { title: "Created", dataIndex: "createdAt", sorter: (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt), render: (v: string) => v.slice(0, 10) },
      { title: "Type", dataIndex: "dealType", render: (v: string) => <Tag>{v}</Tag> },
      { title: "Stage", dataIndex: "stage", sorter: (a, b) => a.stage.localeCompare(b.stage), render: (v: string) => <Tag color="geekblue">{v.replace(/_/g, " ")}</Tag> },
      { title: "Status", dataIndex: "status", render: (v: string) => <Tag color={statusColor[v] ?? "default"}>{v}</Tag> },
      { title: "Amount", dataIndex: "amount", align: "right", sorter: (a, b) => a.amount - b.amount, render: (_, r) => <b>{r.currency} {Number(r.amount).toLocaleString("en-US")}</b> },
      { title: "", key: "open", align: "right", render: (_, r) => <Link className="btn-ghost text-xs" href={`/deals/${r.id}`}>Open</Link> },
    ]} />
  );
}
