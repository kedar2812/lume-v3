import { WebhookDetail } from "@/components/integrations/WebhookDetail";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Webhook · Integrations · LUME" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("integrations.manage");
  const { id } = await params;
  return <WebhookDetail id={id} />;
}
