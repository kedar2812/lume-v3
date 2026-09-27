import { SourceDetail } from "@/components/integrations/SourceDetail";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Google Sheet · Integrations · LUME" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("integrations.manage");
  const { id } = await params;
  return <SourceDetail id={id} />;
}
