import { can } from "@lume/core/shared";
import { AutopilotScreen } from "@/components/autopilot/AutopilotScreen";
import type { AiStatus } from "@/lib/ai/types";
import type { RunsList } from "@/lib/autopilot/types";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "LUME AI · LUME" };

/** Autopilot (spec 2026-10-19 §2): LUME AI's runs, live, for whoever may view leads (each sees their own leads). */
export default async function Page({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const session = await requirePermission("leads.view");
  const [list, ai] = await Promise.all([
    apiGet<RunsList>("/api/v1/autopilot/runs"),
    apiGet<AiStatus>("/api/v1/ai"),
  ]);
  const { run } = await searchParams;
  return (
    <AutopilotScreen
      initial={list.data ?? { runs: [], running: 0 }}
      askedRun={typeof run === "string" ? run : null}
      canStart={can(session.actor, "messages.send_queue")}
      // Off (or unknown), the page says so, and how to switch it on (owner, 2026-10-27).
      off={ai.data?.on ? undefined : { canSwitch: can(session.actor, "integrations.manage") }}
    />
  );
}
