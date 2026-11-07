"use client";

import { Tag } from "antd";
import { DataTable } from "@/components/data-table";

interface Row { id: string; seq: string; when: string; action: string; entityType: string; actor: string }
const family = (a: string) => a.split(".")[0] ?? a;
const colors = ["blue", "green", "gold", "purple", "cyan", "magenta", "volcano", "geekblue"];
const colorOf = (a: string) => colors[[...family(a)].reduce((x, c) => x + c.charCodeAt(0), 0) % colors.length];

export function AuditTable({ rows }: { rows: Row[] }) {
  return (
    <DataTable<Row> rows={rows} pageSize={25} searchKeys={["action", "entityType", "actor"]} empty="No audit entries." columns={[
      { title: "#", dataIndex: "seq", sorter: (a, b) => Number(a.seq) - Number(b.seq), defaultSortOrder: "descend", width: 80 },
      { title: "When (UTC)", dataIndex: "when", sorter: (a, b) => a.when.localeCompare(b.when) },
      { title: "Action", dataIndex: "action", filters: [...new Set(rows.map((r) => family(r.action)))].sort().map((f) => ({ text: f, value: f })), onFilter: (v, r) => family(r.action) === v, render: (v: string) => <Tag color={colorOf(v)}>{v}</Tag> },
      { title: "Entity", dataIndex: "entityType" },
      { title: "Actor", dataIndex: "actor" },
    ]} />
  );
}
