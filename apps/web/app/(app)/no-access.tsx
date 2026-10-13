export function NoAccess() {
  return (
    <section role="alert">
      <h1 className="text-2xl font-semibold">No access</h1>
      <p className="muted mt-1 text-sm">Your role does not include permission to view this page. Ask a workspace administrator if you need it.</p>
    </section>
  );
}
