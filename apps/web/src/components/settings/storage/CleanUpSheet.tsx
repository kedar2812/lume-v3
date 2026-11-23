"use client";
import { useState } from "react";
import { storageCount, storageSize, type CleanKind } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { filesCsvUrl, type Storage } from "@/lib/settings/storage";
import s from "./storage.module.css";

/** What each clean-up is, in the canvas's words. */
export const CLEAN_WORDS: Record<CleanKind, { name: string; what: string; warn?: string }> = {
  closed: {
    name: "Files on leads closed over 6 months ago",
    what: "Won and lost leads. Their messages stay; each file says it was cleared.",
  },
  trash: { name: "Files on leads in the trash", what: "Leads someone deleted. The leads stay in the trash." },
  previews: {
    name: "Previews LUME can make again",
    what: "Not opened in 90 days. Opening the library makes them again.",
  },
  library: { name: "Archived library files", what: "Archived from the file library, and in no template." },
  old: {
    name: "Every chat file older than 12 months",
    what: "On any lead, open ones too.",
    warn: "This includes leads your team is still working.",
  },
};
/** Ticked unless the admin says otherwise: nothing a lead still being worked needs. */
export const DEFAULT_TICKS: CleanKind[] = ["closed", "trash", "previews"];
const ORDER: CleanKind[] = ["closed", "trash", "previews", "library", "old"];

/**
 * Clean up's sheet (approved canvas): each kind with what it gives back, ticked or not; the total moves as boxes do.
 * A kind with nothing to give back isn't offered. The total is "about" when two ticked kinds share a file: the
 * clean-up itself reports what actually came back.
 */
export function CleanUpSheet({
  candidates,
  onClose,
  onClear,
  problem,
}: {
  candidates: Storage["candidates"];
  onClose(): void;
  onClear(kinds: CleanKind[]): void;
  problem?: string | null;
}) {
  const offered = ORDER.map((k) => candidates.find((c) => c.kind === k)).filter(
    (c): c is Storage["candidates"][number] => !!c && c.files > 0,
  );
  const [ticked, setTicked] = useState<CleanKind[]>(
    offered.filter((c) => DEFAULT_TICKS.includes(c.kind)).map((c) => c.kind),
  );
  const total = offered.filter((c) => ticked.includes(c.kind)).reduce((a, c) => a + c.bytes, 0);
  const flip = (k: CleanKind) => setTicked((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]));
  return (
    <Dialog label="Clean up" onClose={onClose} width={600}>
      <div className={s.sheetHead}>
        <h2>Clean up</h2>
        <p>Tick what can go. You see what it gives back before anything is cleared.</p>
      </div>
      {offered.length ? (
        <div className={s.choices}>
          {offered.map((c) => {
            const w = CLEAN_WORDS[c.kind];
            const on = ticked.includes(c.kind);
            return (
              <label key={c.kind} className={s.choice} data-on={on || undefined}>
                <input type="checkbox" checked={on} onChange={() => flip(c.kind)} />
                <span className={s.words}>
                  <b>{w.name}</b>
                  <span>{w.what}</span>
                  {w.warn && on && <em className={s.warn}>{w.warn}</em>}
                </span>
                <span className={s.choiceSize}>
                  <b>{storageSize(c.bytes)}</b>
                  <span>
                    {storageCount(c.files)} {c.files === 1 ? "file" : "files"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      ) : (
        <p className={s.never}>
          Nothing to clear just now: every file here is on a lead someone may still need.
        </p>
      )}
      <p className={s.never}>
        {ticked.includes("old")
          ? "Never cleared: lead details, notes, tasks and the words of every message."
          : "Never cleared: lead details, notes, tasks, the words of every message, and files on leads still open."}
      </p>
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <footer className={s.sheetFoot}>
        <div className={s.total}>
          <span>Gives back</span>
          <b aria-live="polite">{storageSize(total)}</b>
        </div>
        {ticked.length > 0 && (
          <a className={s.listLink} href={filesCsvUrl(ticked)} download>
            List the files first
          </a>
        )}
        <Button variant="primary" disabled={!ticked.length} onClick={() => onClear(ticked)}>
          {ticked.length ? `Clear ${storageSize(total)}` : "Tick something to clear"}
        </Button>
      </footer>
    </Dialog>
  );
}
