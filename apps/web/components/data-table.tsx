"use client";

import { useMemo, useState } from "react";
import { Empty, Input, Table } from "antd";
import type { TableColumnsType } from "antd";

/** Ant Design table with sorting (set `sorter` on a column), paging and an optional search box over the text of every column in `searchKeys`. */
export function DataTable<T extends object>({ rows, columns, rowKey = "id", searchKeys, pageSize = 20, empty = "Nothing here yet." }: {
  rows: T[]; columns: TableColumnsType<T>; rowKey?: string; searchKeys?: (keyof T)[]; pageSize?: number; empty?: string;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !searchKeys?.length) return rows;
    return rows.filter((r) => searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(needle)));
  }, [rows, q, searchKeys]);
  return (
    <div className="flex flex-col gap-3">
      {searchKeys && rows.length > 0 && <Input.Search allowClear placeholder="Search this table" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />}
      <Table<T> size="middle" rowKey={rowKey} columns={columns} dataSource={shown} scroll={{ x: "max-content" }} pagination={shown.length > pageSize ? { pageSize, showSizeChanger: false } : false} locale={{ emptyText: <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} />
    </div>
  );
}
