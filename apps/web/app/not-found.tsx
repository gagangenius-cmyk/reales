import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto mt-24 max-w-md p-6 text-center">
      <p className="text-5xl font-bold" style={{ color: "var(--accent)" }}>404</p>
      <h1 className="mt-2 text-xl font-semibold">Page not found</h1>
      <p className="muted mt-2 text-sm">The page does not exist, or you do not have access to it.</p>
      <Link className="btn mt-5 inline-block" href="/dashboard">Go to dashboard</Link>
    </main>
  );
}
