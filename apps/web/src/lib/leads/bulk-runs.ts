"use client";
import { api } from "@/lib/api";
import { apiQuery, type ListFilters } from "./filters";
import type { BulkAction } from "./types";

/**
 * Phase 7B's bulk runs, for the screens (7C): a run is made from a selection — the leads picked, or everything
 * the current filters show minus the ones unticked — and read back until it finishes.
 */
export type RunAction = BulkAction | { type: "undo"; of: BulkAction["type"] };
export type RunStatus = "queued" | "running" | "done" | "cancelled" | "failed" | "undone";
export type RunView = {
  id: string;
  userId: string;
  action: RunAction;
  selection: {
    kind: "ids" | "filter" | "undo";
    total: number;
    except?: number;
    expected?: number;
    of?: string;
  };
  status: RunStatus;
  total: number;
  done: number;
  skipped: number;
  failed: number;
  skippedBy: Record<string, number>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  undoOf: string | null;
  undoUntil: string | null;
  canUndo: boolean;
};
/** What's selected on the list: picked rows, or every lead that matches (minus the unticked). */
export type Selection = { mode: "ids" | "all"; ids: string[]; except: string[] };
export type SelectionBody =
  { ids: string[] } | { filters: Record<string, string>; except: string[]; expected: number };

/** "All that match" never sends ids: the server reads the same filters as the person, and snapshots them. */
export function selectionBody(sel: Selection, filters: ListFilters, expected: number): SelectionBody {
  if (sel.mode === "ids") return { ids: sel.ids };
  return {
    filters: Object.fromEntries(new URLSearchParams(apiQuery(filters))),
    except: sel.except,
    expected,
  };
}

export const bulkRunsClient = {
  create: (selection: SelectionBody, action: BulkAction) =>
    api.post<{ run: RunView }>("/api/v1/leads/bulk-runs", { selection, action }),
  get: (id: string) => api.get<{ run: RunView }>(`/api/v1/leads/bulk-runs/${id}`),
  list: () => api.get<{ runs: RunView[] }>("/api/v1/leads/bulk-runs"),
  cancel: (id: string) => api.post<{ run: RunView }>(`/api/v1/leads/bulk-runs/${id}/cancel`),
  undo: (id: string) => api.post<{ run: RunView }>(`/api/v1/leads/bulk-runs/${id}/undo`),
};

export const isLive = (r: RunView | null | undefined) =>
  !!r && (r.status === "queued" || r.status === "running");

const n = (v: number) => v.toLocaleString("en-US");
const leads = (v: number) => `${n(v)} ${v === 1 ? "lead" : "leads"}`;
const was = (v: number) => (v === 1 ? "was" : "were");
const it = (v: number) => (v === 1 ? "it" : "them");

/** Why some leads were skipped, in words ("4 were changed by someone after the action, …"). */
export function reasonWords(code: string, count: number): string {
  const c = n(count);
  const w = was(count);
  const words: Record<string, string> = {
    CHANGED_SINCE: `${c} ${w} changed by someone after the action, so LUME kept the newer change`,
    LEAD_NOT_FOUND: `${c} ${w} deleted, or stopped being yours to see, before LUME reached ${it(count)}`,
    NOT_FOUND: `${c} ${w} deleted, or stopped being yours to see, before LUME reached ${it(count)}`,
    FORBIDDEN: `${c} ${count === 1 ? "isn’t" : "aren’t"} yours to change`,
    ASSIGN_OUT_OF_SCOPE: `${c} would have gone outside who you can assign to`,
    LOST_REASON_REQUIRED: `${c} needed a lost reason`,
    REQUIRED_FIELDS: `${c} ${count === 1 ? "needs" : "need"} a field that stage asks for. Fill it in, then move ${it(count)}`,
    ALREADY_VALID: `${c} already had numbers LUME could read, so they stayed as they are`,
    NO_NUMBER: `${c} ${count === 1 ? "has" : "have"} no phone number`,
    STILL_INVALID: `${c} still can’t be read, even with that country`,
    CANCELLED: `${c} weren’t reached: the action was stopped first`,
  };
  return words[code] ?? `${c} couldn’t be changed`;
}

type Names = {
  person: (id: string | null) => string;
  stage: (id: string) => string;
  tag: (id: string) => string;
};

/** One line for a run: "Moving to Contacted" while it works, "12,396 leads assigned to Riya Shah" once done. */
export function runLine(r: RunView, names: Names): string {
  const a = r.action;
  const running = isLive(r);
  const d = r.done;
  if (a.type === "undo") return running ? `Putting back ${leads(r.total)}` : `${leads(d)} put back`;
  if (a.type === "assign") {
    const who = a.ownerId ? names.person(a.ownerId) : null;
    if (running) return who ? `Assigning to ${who}` : "Unassigning";
    return who ? `${leads(d)} assigned to ${who}` : `${leads(d)} unassigned`;
  }
  if (a.type === "stage")
    return running ? `Moving to ${names.stage(a.stageId)}` : `${leads(d)} moved to ${names.stage(a.stageId)}`;
  if (a.type === "tags") {
    const one = (a.add?.length ?? 0) + (a.remove?.length ?? 0) === 1;
    const t = one ? names.tag((a.add ?? a.remove ?? [])[0]!) : null;
    if (running) return t ? (a.add?.length ? `Adding “${t}”` : `Removing “${t}”`) : "Changing tags";
    return t
      ? a.add?.length
        ? `“${t}” added to ${leads(d)}`
        : `“${t}” removed from ${leads(d)}`
      : `Tags changed on ${leads(d)}`;
  }
  if (a.type === "delete") return running ? "Deleting" : `${leads(d)} deleted`;
  return running
    ? "Reading numbers with a country"
    : `${n(d)} ${d === 1 ? "number" : "numbers"} read with a country`;
}

/** How long a finished run took, in words. */
export function took(r: RunView): string | null {
  if (!r.startedAt || !r.finishedAt) return null;
  const s = Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000));
  return s < 60 ? `Done in ${s} ${s === 1 ? "second" : "seconds"}` : `Done in ${Math.round(s / 60)} min`;
}
