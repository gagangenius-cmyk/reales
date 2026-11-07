import { Skeleton } from "antd";

/** Shown immediately while a page's data loads, so navigation feels instant instead of frozen. */
export default function Loading() {
  return (
    <section className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <Skeleton.Input active style={{ width: 240, height: 34 }} />
      <div className="grid gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="card stat"><Skeleton active paragraph={{ rows: 1 }} title={{ width: "40%" }} /></div>)}</div>
      <div className="card p-4"><Skeleton active paragraph={{ rows: 8 }} /></div>
    </section>
  );
}
