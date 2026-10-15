"use client";
import { useState, type FormEvent } from "react";
import { canonicalKey } from "@lume/core/shared";
import { keyFieldValue, REFUSAL_WORDS } from "@/lib/key-words";
import { licenceClient, type LicenceForPerson } from "@/lib/licence/client";
import type { KeyRefusal } from "@/lib/setup-client";
import s from "./licence.module.css";

/**
 * Settings → About, the product key (spec 2026-10-15 §1.3; canvas AboutKey): its last four, and for the owner
 * Change key — the new key is checked with the licence server and replaces the old one only once approved.
 */
export function KeyRow({
  licence,
  onChanged,
  cta,
}: {
  licence: LicenceForPerson;
  onChanged(next: LicenceForPerson): void;
  /** On the lock screen: just this button (no current key line), opening the same form. */
  cta?: string;
}) {
  // An API from before product keys sends none: nothing to show.
  const key = licence.key ?? { masked: null, source: null, canChange: false };
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<KeyRefusal | null>(null);
  if (!key.masked && !key.canChange) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    const typed = canonicalKey(text);
    if (!typed || busy) return;
    setBusy(true);
    setRefused(null);
    const r = await licenceClient.changeKey(typed);
    setBusy(false);
    if (r.ok) {
      onChanged(r.data);
      setOpen(false);
      setText("");
      return;
    }
    const reason = (r.details as { reason?: KeyRefusal } | undefined)?.reason;
    setRefused(reason && reason in REFUSAL_WORDS ? reason : "unreachable");
  }

  return (
    <div className={s.keyRow}>
      <div className={s.keyLine} data-cta={cta ? "" : undefined}>
        {!cta && (
          <div className={s.keyWhat}>
            <span>Product key</span>
            <strong className={s.num}>{key.masked ?? "Not set yet"}</strong>
            {key.source === "env" && <span className={s.keyNote}>Key set on the server</span>}
          </div>
        )}
        {key.canChange && (
          <button
            type="button"
            className={s.btnTint}
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
              setRefused(null);
            }}
          >
            {cta ?? "Change key"}
          </button>
        )}
      </div>
      {open && (
        <form method="post" className={s.keyForm} onSubmit={save} noValidate>
          <label htmlFor="new-product-key">New product key</label>
          <div className={s.keyInputs}>
            <input
              id="new-product-key"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="LUME-XXXX-XXXX-XXXX-XXXX-XXXX"
              value={text}
              readOnly={busy}
              onChange={(e) => {
                setText(keyFieldValue(e.target.value));
                setRefused(null);
              }}
            />
            <button type="submit" className={s.btnPrimary} disabled={!canonicalKey(text) || busy}>
              {busy ? "Checking…" : "Save key"}
            </button>
            <button type="button" className={s.btnGhost} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {refused ? (
            <p role="alert" className={s.keyRefused}>
              {REFUSAL_WORDS[refused]}
            </p>
          ) : (
            <p className={s.keyNote}>
              LUME checks the new key with the licence server before it replaces the old one. It must be a key
              for this LUME; a key in use on another server is refused.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
