"use client";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Catalog } from "@/lib/leads/types";
import { liveSheetsClient, type LiveSheetView } from "@/lib/live-sheets/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useLiveSheets } from "@/lib/notifications/stream";
import { CreateLiveSheet, DRAFT_KEY, type Prefill } from "./CreateLiveSheet";
import { LiveSheetCard } from "./LiveSheetCard";
import s from "./live-sheets.module.css";

export type LiveSheetsLock = { kind: "tier" | "sheets_off" | "not_set_up"; words: string };
/** A draft waits this long for Google's permission screen to send the person back. */
const DRAFT_FOR_MS = 30 * 60_000;

/**
 * Live sheets (spec 2026-11-14 §1): every Google Sheet LUME keeps, the one place to make, edit, pause, update and
 * delete them, each with its link to copy. Moves on by the live stream; a run under way also looks again every few
 * seconds, in case the stream is away.
 */
export function LiveSheetsScreen({
  initial,
  catalog,
  contactsVisible,
  canTakeOver,
  lock,
  openWith,
  resumeGrant,
}: {
  initial: LiveSheetView[];
  catalog: Catalog;
  contactsVisible: boolean;
  canTakeOver: boolean;
  /** Why live sheets can't be made here (the plan, Google Sheets off, Connect with Google not set up). */
  lock: LiveSheetsLock | null;
  /** Opened from Leads or a Pipeline stage: the form, prefilled. */
  openWith?: Prefill;
  /** Back from Google with a new account: the form as it was, with that account chosen. */
  resumeGrant?: string;
}) {
  const reduce = !!useReducedMotion();
  const [sheets, setSheets] = useState(initial);
  const [form, setForm] = useState<null | {
    prefill?: Prefill;
    editing?: LiveSheetView;
    resume?: Parameters<typeof CreateLiveSheet>[0]["resume"];
  }>(() => (openWith && !lock ? { prefill: openWith } : null));

  // Back from Google's permission screen: the draft the form left, if it's recent.
  useEffect(() => {
    if (!resumeGrant || lock) return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      sessionStorage.removeItem(DRAFT_KEY);
      const saved = raw ? (JSON.parse(raw) as { draft: unknown; at: number }) : null;
      if (saved && Date.now() - saved.at < DRAFT_FOR_MS)
        setForm({ resume: { draft: saved.draft as never, grantId: resumeGrant } });
    } catch {
      // No storage here: the person starts the form again.
    }
  }, [resumeGrant, lock]);

  const put = useCallback(
    (x: LiveSheetView) =>
      setSheets((xs) =>
        xs.some((y) => y.id === x.id) ? xs.map((y) => (y.id === x.id ? x : y)) : [x, ...xs],
      ),
    [],
  );
  const drop = useCallback((id: string) => setSheets((xs) => xs.filter((x) => x.id !== id)), []);
  const reread = useCallback(
    async (id: string) => {
      const r = await liveSheetsClient.get(id);
      if (r.ok) put(r.data.sheet);
      else if (r.status === 404) drop(id);
    },
    [put, drop],
  );
  const rereadAll = useCallback(async () => {
    const r = await liveSheetsClient.list();
    if (r.ok) setSheets(r.data.sheets);
  }, []);

  useLiveSheets((e) => {
    if (e.sheet === "*") void rereadAll();
    else void reread(e.sheet);
  });
  const running = sheets.some((x) => x.run && (x.run.status === "queued" || x.run.status === "running"));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void rereadAll(), 5000);
    return () => clearInterval(t);
  }, [running, rereadAll]);

  const create = !lock && (
    <Button variant="primary" onClick={() => setForm({})}>
      Create a live sheet
    </Button>
  );

  return (
    <section className={s.page} aria-labelledby="ls-title">
      <header className={s.head}>
        <div className={s.title}>
          <h1 id="ls-title">Live sheets</h1>
          <p>
            Google Sheets LUME keeps up to date with the leads you choose. Copy a sheet&apos;s link to use it
            anywhere.
          </p>
        </div>
        {sheets.length > 0 && create}
      </header>

      {lock && (
        <div className={s.lock} role="status">
          <h2>
            {lock.kind === "tier"
              ? "Live sheets come with Pro"
              : lock.kind === "sheets_off"
                ? "Google Sheets is off"
                : "Not set up here"}
          </h2>
          <p>{lock.words}</p>
          {lock.kind === "tier" && (
            <a className={s.open} href="/settings/about#plan">
              See your plan
            </a>
          )}
          {lock.kind === "sheets_off" && (
            <a className={s.open} href="/settings/integrations">
              Go to Integrations
            </a>
          )}
        </div>
      )}

      {sheets.length === 0 && !lock ? (
        <EmptyState
          title="No live sheets yet"
          body="A live sheet is a Google Sheet LUME keeps filled with the leads you choose: the leads that qualified, for a Meta audience, or every client you won."
          action={create || undefined}
        />
      ) : (
        <div className={s.list}>
          {sheets.map((x, i) => (
            <motion.div
              key={x.id}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={
                reduce ? { duration: 0 } : { ...toMotion(SPRINGS.default), delay: Math.min(i, 8) * 0.04 }
              }
            >
              <LiveSheetCard
                sheet={x}
                canTakeOver={canTakeOver}
                onChange={put}
                onEdit={(sheet) => setForm({ editing: sheet })}
                onDeleted={drop}
              />
            </motion.div>
          ))}
        </div>
      )}

      {form && (
        <CreateLiveSheet
          catalog={catalog}
          contactsVisible={contactsVisible}
          {...(form.prefill ? { prefill: form.prefill } : {})}
          {...(form.editing ? { editing: form.editing } : {})}
          {...(form.resume ? { resume: form.resume } : {})}
          onClose={() => setForm(null)}
          onSaved={put}
        />
      )}
    </section>
  );
}
