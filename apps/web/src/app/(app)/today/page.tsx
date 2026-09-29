import { can } from "@lume/core/shared";
import { Today } from "@/components/today/Today";
import { requireSession } from "@/server/session";

export const metadata = { title: "Today · LUME" };

export default async function Page() {
  const session = await requireSession();
  return (
    <section data-stagger>
      <Today
        name={session.user.name}
        tz={session.user.timezone}
        canMessage={can(session.actor, "messages.send")}
      />
    </section>
  );
}
