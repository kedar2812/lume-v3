import { can } from "@lume/core/shared";
import { RepliesBoard } from "@/components/replies/RepliesBoard";
import type { LostReason, Pipeline } from "@/lib/leads/types";
import type { ReplyBoard } from "@/lib/replies/client";
import { apiGet } from "@/server/api";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Who replied · LUME" };

const WEEK = 7 * 86_400_000;

/**
 * Who replied (W2, spec 2026-10-18 §4.2): WhatsApp replies since a moment (`?since=`, from Today or a send; else the
 * last 7 days), grouped by what they mean, for whoever may view leads (each sees their own).
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ since?: string }> }) {
  const session = await requirePermission("leads.view");
  const { since } = await searchParams;
  const from =
    typeof since === "string" && !Number.isNaN(Date.parse(since))
      ? new Date(since).toISOString()
      : new Date(Date.now() - WEEK).toISOString();
  const [board, pipelines, reasons] = await Promise.all([
    apiGet<ReplyBoard>(`/api/v1/whatsapp/replies?since=${encodeURIComponent(from)}`),
    apiGet<{ pipelines: Pipeline[] }>("/api/v1/pipelines"),
    apiGet<{ lostReasons: LostReason[] }>("/api/v1/lost-reasons"),
  ]);
  const pipeline = pipelines.data?.pipelines.find((p) => p.isDefault) ?? pipelines.data?.pipelines[0];
  return (
    <RepliesBoard
      initial={board.data ?? { since: from, groups: [] }}
      stages={(pipeline?.stages ?? []).map((x) => ({ id: x.id, name: x.name, kind: x.kind }))}
      lostReasons={(reasons.data?.lostReasons ?? []).map((r) => ({ id: r.id, label: r.label }))}
      canBulk={can(session.actor, "leads.bulk_edit")}
    />
  );
}
