import { can, scopeOf } from "@lume/core/shared";
import { Today } from "@/components/today/Today";
import { apiGet } from "@/server/api";
import { requireSession } from "@/server/session";
import { zoneOf } from "@/lib/zone";

export const metadata = { title: "Today · LUME" };

export default async function Page() {
  const session = await requireSession();
  // The business's currency, for money on the tiles (the tiles themselves check who may see money).
  const currency = (await apiGet<{ currency: string }>("/api/v1/settings")).data?.currency ?? "USD";
  return (
    <section data-stagger>
      <Today
        name={session.user.name}
        tz={zoneOf(session.user)}
        canMessage={can(session.actor, "messages.send")}
        canQueue={can(session.actor, "messages.send_queue")}
        currency={currency}
        own={scopeOf(session.actor, "leads.view") === "own"}
        canSetUp={can(session.actor, "settings.manage")}
      />
    </section>
  );
}
