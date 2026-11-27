import { can } from "@lume/core/shared";
import { QueueRun } from "@/components/queue/QueueRun";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Send queue · LUME" };

/** A run (4C, plan ruling R4): its own address, so a reload or a second tab opens it where it is. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("messages.send_queue");
  const { id } = await params;
  // Let LUME AI take the rest (2026-11-26): with LUME AI on, as Who replied offers it.
  const ai = await apiGet<{ on: boolean }>("/api/v1/ai");
  return (
    <QueueRun
      id={id}
      tz={session.user.timezone ?? undefined}
      canAi={!!ai.data?.on && can(session.actor, "messages.send_queue")}
    />
  );
}
