import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listMyNotifications } from "@reales/domain";
import { requireContext } from "@/lib/page-context";
import { NotificationActions } from "./notification-actions";

export const metadata = { title: "Notifications | Reales CRM" };

const href = (n: any) => (n.entityType === "lead" ? `/leads/${n.entityId}` : n.entityType === "listing" ? "/listings" : null);

export default async function Notifications() {
  const ctx = await requireContext();
  const items: any[] = await listMyNotifications(getSequelize(), ctx, { limit: 100 });
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <NotificationActions unread={items.filter((n) => !n.readAt).length} />
      </div>
      <ul className="card divide-y">
        {items.map((n) => (
          <li key={n.id} className={`p-3 text-sm ${n.readAt ? "opacity-60" : ""}`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{n.title}</p>
                {n.body && <p className="muted">{n.body}</p>}
                <p className="muted text-xs">{new Date(n.createdAt).toISOString().slice(0, 16).replace("T", " ")}{href(n) && <> - <Link className="underline" href={href(n)!}>Open</Link></>}</p>
              </div>
              {!n.readAt && <NotificationActions id={n.id} />}
            </div>
          </li>
        ))}
        {items.length === 0 && <li className="muted p-3 text-sm">Nothing yet. You will be told here when a new listing matches one of your leads or saved searches.</li>}
      </ul>
    </section>
  );
}
