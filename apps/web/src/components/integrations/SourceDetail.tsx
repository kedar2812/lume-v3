"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AddSheetSheet } from "@/components/sheets/AddSheetSheet";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { shortDateTime } from "@/lib/settings/format";
import { sheetsClient } from "@/lib/sheets/client";
import { ago, inFuture } from "@/lib/sheets/format";
import { RETRYABLE, type SheetSourceDetail, type SyncView } from "@/lib/sheets/types";
import s from "./integrations.module.css";

const TRIGGER: Record<SyncView["trigger"], string> = {
  schedule: "On its own",
  refresh: "Refresh",
  connect: "When connected",
  manual: "Sync now",
};
const EVERY = [60, 120, 300, 900, 1800, 3600];
const every = (v: number) =>
  v < 3600 ? `Every ${v / 60 === 1 ? "minute" : `${v / 60} minutes`}` : "Every hour";
const n = (v: number) => v.toLocaleString("en");

/** "3 new · 1 merged · 1 problem", "Up to date", or why it didn't finish. */
function outcome(x: SyncView): string {
  if (x.status === "queued" || x.status === "running") return "Checking…";
  if (x.status === "failed")
    return x.error === "stopped"
      ? "Stopped"
      : x.error && /^[A-Z_]+$/.test(x.error)
        ? "Needed attention"
        : (x.error ?? "Didn't finish");
  const parts = [
    x.created && `${n(x.created)} new`,
    x.merged && `${n(x.merged)} merged`,
    x.errors && `${n(x.errors)} ${x.errors === 1 ? "problem" : "problems"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Up to date";
}

/** Spec §7.3: is it working, what did it do, what needs you — and every action, one tap away. */
export function SourceDetail({ id }: { id: string }) {
  const router = useRouter();
  const [v, setV] = useState<SheetSourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await sheetsClient.get(id);
    if (!r.ok) return setError(r.message);
    setV(r.data);
  }, [id]);
  useEffect(() => void load(), [load]);
  // While it's checking, look again every 2 seconds, so the page says when it's done.
  useEffect(() => {
    if (!v?.syncing) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [v, load]);

  if (error)
    return (
      <p role="alert" className={s.error}>
        {error}
      </p>
    );
  if (!v) return null;

  const act = async (f: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await f();
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "Something went wrong.");
    await load();
  };
  const retryable = v.attention && RETRYABLE.has(v.attention.code);

  return (
    <div className={s.detail}>
      <Link href="/settings/integrations" className={s.back}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path
            d="M7.5 2.5 4 6l3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Integrations
      </Link>
      <header className={s.detailHead}>
        <span className={s.brandTile}>
          <img src="/brand/google-sheets.png" alt="" width={28} height={28} />
        </span>
        <div>
          <h2 className={s.cardTitle}>{v.name}</h2>
          <p className={s.cardLede}>
            Tab “{v.tabTitle}” ·{" "}
            <a href={v.link} target="_blank" rel="noopener noreferrer">
              Open in Google Sheets
            </a>
          </p>
        </div>
      </header>

      {v.attention && (
        <section className={s.attention} aria-label="Needs attention">
          <p>{v.attention.message}</p>
          {retryable ? (
            <Button variant="primary" loading={busy} onClick={() => void act(() => sheetsClient.sync(id))}>
              Test again
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setEditing(true)}>
              Open columns
            </Button>
          )}
        </section>
      )}
      {v.failing && (
        <p className={s.warnLine}>
          LUME hasn't reached Google for the last few tries. It keeps trying on its own.
        </p>
      )}
      {v.newColumns.length > 0 && (
        <p className={s.infoLine}>
          {v.newColumns.length === 1
            ? `1 new column: ${v.newColumns[0]}.`
            : `${v.newColumns.length} new columns: ${v.newColumns.join(", ")}.`}{" "}
          <button type="button" className={s.inlineLink} onClick={() => setEditing(true)}>
            Map {v.newColumns.length === 1 ? "it" : "them"}
          </button>
        </p>
      )}

      <dl className={s.health}>
        <div>
          <dt>Last checked</dt>
          <dd>{v.syncing ? "Checking now" : v.lastSyncedAt ? ago(v.lastSyncedAt) : "Not yet"}</dd>
        </div>
        <div>
          <dt>Next check</dt>
          <dd>{v.status === "paused" ? "Paused" : v.nextSyncAt ? inFuture(v.nextSyncAt) : "—"}</dd>
        </div>
        <div>
          <dt>New today</dt>
          <dd>{n(v.newToday)}</dd>
        </div>
        <div>
          <dt>All time</dt>
          <dd>{n(v.newAllTime)}</dd>
        </div>
        <div>
          <dt>Problems</dt>
          <dd>{n(v.problems)}</dd>
        </div>
      </dl>

      <div className={s.actions}>
        {v.status === "active" && (
          <Button loading={busy || v.syncing} onClick={() => void act(() => sheetsClient.sync(id))}>
            Sync now
          </Button>
        )}
        {v.status !== "needs_attention" && (
          <Button onClick={() => void act(() => sheetsClient.patch(id, { paused: v.status === "active" }))}>
            {v.status === "paused" ? "Resume" : "Pause"}
          </Button>
        )}
        {v.canSeeRows && <Button onClick={() => setEditing(true)}>Edit columns and rules</Button>}
        <label className={s.every}>
          <span className={s.srOnly}>How often</span>
          <select
            aria-label="How often"
            value={v.pollSeconds}
            onChange={(e) => void act(() => sheetsClient.patch(id, { pollSeconds: Number(e.target.value) }))}
          >
            {EVERY.map((x) => (
              <option key={x} value={x}>
                {every(x)}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          className={s.danger}
          aria-label="Remove sheet"
          onClick={() => setRemoving(true)}
        >
          Remove
        </Button>
      </div>
      {v.runAs && <p className={s.cardLede}>Runs as {v.runAs.name}, who last saved its columns.</p>}

      <section aria-labelledby="syncs-title">
        <h3 id="syncs-title" className={s.sectionTitle}>
          Recent syncs
        </h3>
        <table className={s.table} aria-label="Recent syncs">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">How</th>
              <th scope="col">What happened</th>
            </tr>
          </thead>
          <tbody>
            {v.syncs.map((x) => (
              <tr key={x.id}>
                <td>{x.startedAt ? shortDateTime(x.startedAt) : "Waiting"}</td>
                <td>{TRIGGER[x.trigger]}</td>
                <td>{outcome(x)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {v.problemRows.length > 0 && (
        <section aria-labelledby="problems-title">
          <div className={s.sectionHead}>
            <h3 id="problems-title" className={s.sectionTitle}>
              Problem rows
            </h3>
            {v.canSeeRows && (
              <a href={sheetsClient.problemsUrl(id)} download>
                Download problem rows
              </a>
            )}
          </div>
          <p className={s.cardLede}>Fix a row in the sheet and LUME tries it again on its next check.</p>
          <ul className={s.problems}>
            {v.problemRows.map((p) => (
              <li key={p.id}>
                <span className={s.rowNo}>Row {p.rowNumber}</span>
                <span>{p.problems.map((x) => x.message).join(" ")}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Dismiss row ${p.rowNumber}`}
                  onClick={() => void act(() => sheetsClient.dismiss(id, p.id))}
                >
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AddSheetSheet
        open={editing}
        sourceId={id}
        onClose={() => {
          setEditing(false);
          void load();
        }}
      />
      {removing && (
        <Dialog label="Remove this sheet?" onClose={() => setRemoving(false)}>
          <h3 className={s.sectionTitle}>Remove this sheet?</h3>
          <p className={s.cardLede}>Its leads stay in LUME. New rows in “{v.name}” won't come in any more.</p>
          <div className={s.actions}>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const r = await sheetsClient.remove(id);
                if (r.ok) router.push("/settings/integrations");
              }}
            >
              Remove
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
