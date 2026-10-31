import { notFound } from "next/navigation";
import { SourceDetail } from "@/components/integrations/SourceDetail";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Google Sheet · Integrations · LUME" };

/** A sheet's id: anything else here ("whatsapp", a typo) is a page that isn't there, said so (2026-10-31). */
const SHEET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("integrations.manage");
  const { id } = await params;
  if (!SHEET_ID.test(id)) notFound();
  return <SourceDetail id={id} />;
}
