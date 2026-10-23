import { requireContext } from "@/lib/page-context";
import { AssistantClient } from "./assistant-client";

export const metadata = { title: "Assistant | Reales CRM" };

export default async function Assistant() {
  await requireContext();
  return (
    <section className="flex flex-col gap-4">
      <div className="page-head"><div><h1>Assistant</h1><p className="muted text-sm">Ask in plain words. It only reads what you are already allowed to see, and always links to the real screen.</p></div></div>
      <AssistantClient />
    </section>
  );
}
