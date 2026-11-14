import { can, seesFullContacts, tierAllows, tierName, tiersWith } from "@lume/core/shared";
import { LiveSheetsScreen, type LiveSheetsLock } from "@/components/live-sheets/LiveSheetsScreen";
import type { LiveSheetView } from "@/lib/live-sheets/client";
import { apiGet } from "@/server/api";
import { loadCatalog } from "@/server/leads";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Live sheets · LUME" };

const UUID = /^[0-9a-f-]{36}$/;
const ids = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : v ? v.split(",") : []).filter((x) => UUID.test(x)).slice(0, 20);

/**
 * Live sheets (spec 2026-11-14 §1): every Google Sheet LUME keeps up to date. Opened from Leads or a Pipeline stage
 * with `?new=1&stage=…&source=…&tag=…&owner=…`, the form opens prefilled; back from Google, `?grant=` resumes it.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("leads.live_sheets");
  const q = await searchParams;
  const [list, catalog] = await Promise.all([
    apiGet<{ sheets: LiveSheetView[]; setup: { sheetsOn: boolean; connectWithGoogle: boolean } }>(
      "/api/v1/live-sheets",
    ),
    loadCatalog(),
  ]);
  const tier = session.licence.tier;
  const setup = list.data?.setup;
  const lock: LiveSheetsLock | null = !tierAllows({ tier }, "live_sheets")
    ? {
        kind: "tier",
        words: `Live sheets come with ${tiersWith("live_sheets")}. Your LUME is on ${tierName(tier!)}.`,
      }
    : !can(session.actor, "leads.export")
      ? {
          kind: "not_set_up",
          words:
            "Live sheets take leads out of LUME, so making one needs Export leads too. An admin can add it to your role.",
        }
      : setup && !setup.connectWithGoogle
        ? {
            kind: "not_set_up",
            words: "Connect with Google isn't set up on this LUME, so it can't make sheets yet.",
          }
        : setup && !setup.sheetsOn
          ? {
              kind: "sheets_off",
              words: "Switch on Google Sheets in Settings → Integrations to make live sheets.",
            }
          : null;
  const grant = typeof q.grant === "string" && UUID.test(q.grant) ? q.grant : undefined;
  const prefill =
    q.new === "1"
      ? {
          stageIds: ids(q.stage),
          sourceIds: ids(q.source),
          tagIds: ids(q.tag),
          ownerIds: ids(q.owner),
        }
      : undefined;
  return (
    <LiveSheetsScreen
      initial={list.data?.sheets ?? []}
      catalog={catalog}
      contactsVisible={seesFullContacts(session.actor)}
      canTakeOver={session.actor.isOwner || can(session.actor, "users.manage")}
      lock={lock}
      {...(prefill ? { openWith: prefill } : {})}
      {...(grant ? { resumeGrant: grant } : {})}
    />
  );
}
