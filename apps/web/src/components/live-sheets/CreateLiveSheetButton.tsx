"use client";
import { tierAllows, tierName, tiersWith } from "@lume/core/shared";
import { useState } from "react";
import { useTier } from "@/components/licence/LicenceProvider";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { Catalog } from "@/lib/leads/types";
import { liveSheetsClient } from "@/lib/live-sheets/client";
import { CreateLiveSheet, type Prefill } from "./CreateLiveSheet";
import s from "./live-sheets.module.css";

const SheetIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden>
    <path
      d="M14 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V11M4.5 9.5h15M4.5 15h15M10 9.5v11"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="18.5" cy="5" r="2.5" fill="currentColor" />
  </svg>
);

/**
 * Create a live sheet, from Leads (with the filters on screen) or a Pipeline stage (with that stage): the form opens
 * right here. On a plan without live sheets, or with Google Sheets off, it says so instead of opening a form that
 * can't finish.
 */
export function CreateLiveSheetButton({
  catalog,
  contactsVisible,
  prefill,
  label = "Create a live sheet",
  iconOnly = false,
  squeeze = false,
  className,
}: {
  catalog: Catalog;
  contactsVisible: boolean;
  /** Read when pressed: the screen's filters as they are then. */
  prefill: () => Prefill;
  label?: string;
  /** A small icon button (a Pipeline column's), named by `label`. */
  iconOnly?: boolean;
  /** Below 1600px wide, just its icon (named, with the words as a tooltip): Pipeline's one-row toolbar has no room. */
  squeeze?: boolean;
  className?: string;
}) {
  const { tier } = useTier();
  const [open, setOpen] = useState<Prefill | null>(null);
  const [lock, setLock] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const press = async () => {
    if (!tierAllows({ tier }, "live_sheets"))
      return setLock(
        `Live sheets come with ${tiersWith("live_sheets")}. Your LUME is on ${tierName(tier!)}.`,
      );
    setChecking(true);
    const r = await liveSheetsClient.list();
    setChecking(false);
    if (r.ok && !r.data.setup.connectWithGoogle)
      return setLock("Connect with Google isn't set up on this LUME, so it can't make sheets yet.");
    if (r.ok && !r.data.setup.sheetsOn)
      return setLock("Switch on Google Sheets in Settings → Integrations to make live sheets.");
    setOpen(prefill());
  };

  return (
    <>
      {iconOnly ? (
        <button
          type="button"
          className={className}
          aria-label={label}
          title={label}
          aria-busy={checking || undefined}
          onClick={() => void press()}
        >
          <SheetIcon />
        </button>
      ) : (
        <Button
          variant="secondary"
          className={[squeeze && s.squeeze, className].filter(Boolean).join(" ") || undefined}
          title={squeeze ? label : undefined}
          loading={checking}
          onClick={() => void press()}
        >
          <SheetIcon />
          {squeeze ? <span className={s.squeezeWords}>{label}</span> : label}
        </Button>
      )}
      {lock && (
        <Dialog label="Live sheets" onClose={() => setLock(null)}>
          <div className={s.form}>
            <h2 className={s.name}>Live sheets aren&apos;t ready here</h2>
            <p className={s.lede}>{lock}</p>
            <div className={s.foot}>
              <span className={s.grow} />
              <Button variant="primary" onClick={() => setLock(null)}>
                OK
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {open && (
        <CreateLiveSheet
          catalog={catalog}
          contactsVisible={contactsVisible}
          prefill={open}
          onClose={() => setOpen(null)}
          onSaved={() => undefined}
        />
      )}
    </>
  );
}
