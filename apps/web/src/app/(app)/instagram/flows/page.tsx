import { FlowsList } from "@/components/flows/FlowsList";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Flows · Instagram · LUME" };

/** The Flows page (plan 2026-11-25-instagram-screens D3): whoever may manage Instagram flows. */
export default async function Page() {
  await requirePermission("instagram.flows.manage");
  return <FlowsList />;
}
