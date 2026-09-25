import { BoardScreen } from "@/components/board/BoardScreen";
import { EmptyState } from "@/components/ui/EmptyState";
import { BOARD_PAGE } from "@/lib/leads/filters";
import { loadBoard } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Pipeline · LUME" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("leads.view");
  const raw = await searchParams;
  const params = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
    ),
  );
  const { catalog, pipeline, filters, columns, counts, values } = await loadBoard(params, BOARD_PAGE);
  if (!pipeline)
    return (
      <EmptyState title="No pipeline yet" body="An admin can set one up in Settings, under Pipelines." />
    );
  const lead = params.get("lead");
  return (
    <BoardScreen
      key={pipeline.id}
      session={session}
      catalog={catalog}
      pipeline={pipeline}
      filters={filters}
      columns={columns}
      counts={counts}
      values={values}
      initialLeadId={lead && /^[0-9a-f-]{36}$/.test(lead) ? lead : null}
    />
  );
}
