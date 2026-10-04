import { can } from "@lume/core/shared";
import { Today } from "@/components/today/Today";
import { apiGet } from "@/server/api";
import { requireSession } from "@/server/session";

export const metadata = { title: "Today · LUME" };

export default async function Page() {
  const session = await requireSession();
  // The quick stats and the pipeline (frontend spec §8.2) for whoever may read Analytics, in the business's currency.
  const analytics = can(session.actor, "analytics.view")
    ? { currency: (await apiGet<{ currency: string }>("/api/v1/settings")).data?.currency ?? "USD" }
    : undefined;
  return (
    <section data-stagger>
      <Today
        name={session.user.name}
        tz={session.user.timezone}
        canMessage={can(session.actor, "messages.send")}
        canQueue={can(session.actor, "messages.send_queue")}
        {...(analytics ? { analytics } : {})}
      />
    </section>
  );
}
