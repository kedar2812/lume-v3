"use client";
import { useCallback, useEffect, useState } from "react";
import { ImportSheet } from "@/components/imports/ImportSheet";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { importsClient } from "@/lib/imports/client";
import type { ImportStatus, ImportView } from "@/lib/imports/types";
import { accessGone } from "@/lib/settings/access";
import { shortDateTime } from "@/lib/settings/format";
import { AccessChanged } from "./AccessChanged";
import s from "./settings.module.css";

const STATUS: Record<ImportStatus, string> = {
  draft: "Draft",
  queued: "Waiting to start",
  running: "Importing",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  stopped_access: "Stopped: access changed",
  failed: "Failed",
  done: "Done",
};
const n = (v: number) => v.toLocaleString("en");

/** "812 created · 40 merged · 3 with problems": what it did, zeros left out. */
function outcome(v: ImportView): string {
  const c = v.counts;
  const parts = [
    c.created && `${n(c.created)} created`,
    c.merged && `${n(c.merged)} merged`,
    c.skipped && `${n(c.skipped)} skipped`,
    c.errors && `${n(c.errors)} with problems`,
  ].filter(Boolean);
  if (v.status === "draft") return `${n(v.rowCount)} rows, not started`;
  return parts.length ? parts.join(" · ") : `${n(v.rowCount)} rows`;
}

type Open = { draftId: string } | { importId: string } | null;

/**
 * Settings → Imports (spec §9.6): every import, newest first — its report, and drafts to finish. Someone
 * else's draft never shows; their finished imports do, with counts (rows only for those allowed).
 */
export function ImportsList() {
  const [items, setItems] = useState<ImportView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"ready" | "loading" | "error" | "gone">("loading");
  const [open, setOpen] = useState<Open>(null);

  const load = useCallback(async (after?: string) => {
    setState("loading");
    const r = await importsClient.list(after);
    if (!r.ok) return setState(accessGone(r) ? "gone" : "error");
    setItems((prev) => (after ? [...(prev ?? []), ...r.data.imports] : r.data.imports));
    setCursor(r.data.nextCursor);
    setState("ready");
  }, []);
  useEffect(() => void load(), [load]);

  if (state === "gone") return <AccessChanged />;

  return (
    <div className={s.stack}>
      {items !== null && items.length === 0 ? (
        <EmptyState
          title="No imports yet"
          body="Bring leads in from a CSV with Import on the Leads page. Every import and its report shows here."
        />
      ) : (
        <section className={s.panel} aria-label="Past imports" aria-busy={items === null || undefined}>
          {items === null ? (
            <p className={`${s.muted} ${s.panelBody}`}>Loading…</p>
          ) : (
            <ul className={s.importList}>
              {items.map((v) => (
                <li key={v.id} className={s.importRow}>
                  <div className={s.importMain}>
                    <h3 className={s.importName}>{v.fileName}</h3>
                    <p className={s.importMeta}>
                      <span className={s.statusChip} data-status={v.status}>
                        {STATUS[v.status]}
                      </span>
                      <span>{outcome(v)}</span>
                    </p>
                    <p className={s.importWhen}>
                      {v.startedBy ? `${v.startedBy.name} · ` : ""}
                      <time dateTime={v.startedAt ?? v.createdAt}>
                        {shortDateTime(v.startedAt ?? v.createdAt)}
                      </time>
                    </p>
                  </div>
                  {v.status === "draft" ? (
                    <Button
                      size="sm"
                      aria-label={`Continue draft ${v.fileName}`}
                      onClick={() => setOpen({ draftId: v.id })}
                    >
                      Continue
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Open the report for ${v.fileName}`}
                      onClick={() => setOpen({ importId: v.id })}
                    >
                      {["queued", "running", "cancelling"].includes(v.status) ? "Watch" : "Report"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {state === "error" && (
        <p role="alert" className={s.problem}>
          The imports couldn’t load. Try again in a moment.
        </p>
      )}
      {cursor !== null && (
        <Button variant="secondary" loading={state === "loading"} onClick={() => void load(cursor)}>
          Load earlier
        </Button>
      )}
      <ImportSheet
        open={open !== null}
        {...(open && "draftId" in open ? { draftId: open.draftId } : {})}
        {...(open && "importId" in open ? { importId: open.importId } : {})}
        onClose={() => {
          setOpen(null);
          void load();
        }}
      />
    </div>
  );
}
