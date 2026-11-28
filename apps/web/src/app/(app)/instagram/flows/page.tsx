import { FlowsList } from "@/components/flows/FlowsList";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Flows · Instagram · LUME" };

/** The Flows page (plan 2026-11-25-instagram-screens D3): whoever may manage Instagram flows. */
export default async function Page() {
  await requirePermission("instagram.flows.manage");
  // The business's one currency, for the money its flows brought (shown only to those who see money).
  // Its time zone: the ranges end on its today (owner 2026-11-28: any range, picked on a calendar).
  const settings = await apiGet<{ currency: string; timezone: string | null }>("/api/v1/settings");
  return <FlowsList currency={settings.data?.currency ?? null} tz={settings.data?.timezone ?? "UTC"} />;
}
