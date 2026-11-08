/** Shown immediately while a page's data loads. Plain markup and CSS only: this file runs on the server, where client-only libraries must not be dotted into. */
export default function Loading() {
  return (
    <section className="flex flex-col gap-5" aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ width: 240, height: 34 }} />
      <div className="grid gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="card stat"><div className="skel" style={{ width: "45%", height: 12 }} /><div className="skel mt-3" style={{ width: "60%", height: 28 }} /></div>)}</div>
      <div className="card flex flex-col gap-3 p-4">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skel" style={{ width: `${95 - i * 6}%`, height: 16 }} />)}</div>
    </section>
  );
}
