"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";
import k from "./sheets.module.css";
import { sheetsClient } from "@/lib/sheets/client";
import type { InspectView, PickedFile } from "@/lib/sheets/types";

/**
 * Step 1: which sheet and tab. LUME checks it can open the sheet before anything else, and says exactly
 * what to do when it can't (share it with this email, as a Viewer).
 */
export function SheetStep({
  busy,
  picked,
  onChoose,
}: {
  busy: boolean;
  /** A file picked with Connect with Google (2B-2): its tabs are listed, and there's no link to paste. */
  picked?: PickedFile;
  onChoose(o: { link: string; sheetId: number } | { connectId: string; sheetId: number }): void;
}) {
  const [link, setLink] = useState("");
  const [found, setFound] = useState<InspectView | null>(null);
  const [tab, setTab] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    void sheetsClient.inspect({ connectId: picked.connectId }).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setFound(r.data);
      setTab(r.data.tabs[0]?.sheetId ?? null);
    });
    return () => {
      live = false;
    };
  }, [picked]);

  const check = async () => {
    setChecking(true);
    setError(null);
    setFound(null);
    const r = await sheetsClient.inspect(link);
    setChecking(false);
    if (!r.ok) return setError(r.message);
    setFound(r.data);
    setTab(
      r.data.tabs.some((t) => t.sheetId === r.data.gid) ? r.data.gid : (r.data.tabs[0]?.sheetId ?? null),
    );
  };

  return (
    <>
      <section className={s.body}>
        <h3 className={s.stepTitle}>{picked ? "Choose the tab" : "Choose a sheet"}</h3>
        <p className={s.lede}>
          {picked
            ? "LUME can open this file because you picked it. It only ever reads it."
            : "Paste the link from the sheet's address bar. LUME only ever reads it."}
        </p>
        {!picked && (
          <div className={k.linkRow}>
            <label className={k.field}>
              <span>Sheet link</span>
              <input
                className={s.input}
                type="url"
                value={link}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                onChange={(e) => {
                  setLink(e.target.value);
                  setFound(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && link.trim()) void check();
                }}
              />
            </label>
            <Button loading={checking} disabled={!link.trim()} onClick={() => void check()}>
              Check
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className={`${s.note} ${s.problem}`}>
            {error}
          </p>
        )}
        {found && (
          <div className={k.found}>
            <p className={k.foundTitle}>
              <img src="/brand/google-sheets.png" alt="" width={18} height={18} className={k.inlineMark} />
              {found.title}
            </p>
            <label className={k.field}>
              <span>Tab</span>
              <select className={s.select} value={tab ?? ""} onChange={(e) => setTab(Number(e.target.value))}>
                {found.tabs.map((t) => (
                  <option key={t.sheetId} value={t.sheetId}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>LUME finds the header row itself; you can change it on the next step.</p>
        <Button
          variant="primary"
          loading={busy}
          disabled={!found || tab === null}
          onClick={() =>
            onChoose(picked ? { connectId: picked.connectId, sheetId: tab! } : { link, sheetId: tab! })
          }
        >
          Continue
        </Button>
      </footer>
    </>
  );
}
