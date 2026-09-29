import { QueueRun } from "@/components/queue/QueueRun";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Send queue · LUME" };

/** A run (4C, plan ruling R4): its own address, so a reload or a second tab opens it where it is. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("messages.send_queue");
  const { id } = await params;
  return <QueueRun id={id} />;
}
