"use client";
import { useState, type FormEvent } from "react";
import { displayKey, keyChars, KEY_CHARS } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import type { KeyAnswer, KeyLicence, KeyRefusal } from "@/lib/setup-client";
import k from "./key.module.css";
import s from "./setup.module.css";

/** What each refusal says, in LUME's voice (spec 2026-10-15 §1.1; canvas KeyStates). */
export const REFUSAL_WORDS: Record<KeyRefusal, string> = {
  format: "That doesn’t look like a LUME key yet: it has five groups of four.",
  not_recognised: "LUME doesn’t recognise that key. Check it against the message you were sent.",
  in_use: "This key is already active on another LUME. Ask whoever gave it to you to release it.",
  decommissioned: "This key has been decommissioned and works nowhere. Use the newest key you were sent.",
  paused: "This key’s licence is paused.",
  too_many: "Too many tries. Try again in an hour.",
  unreachable:
    "LUME couldn’t reach the licence server. Check this server’s internet connection, then try again.",
};

/** Still typing "LUME" itself (L, LU, LUM, LUME, any case, any punctuation): nothing of the key yet. */
const typedPrefix = (v: string) => {
  const alnum = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return alnum.length > 0 && "LUME".startsWith(alnum);
};

/**
 * Setup's first step on a client's install (spec 2026-10-15 §1.1; canvas Main): the product key, grouped as it's
 * typed, a five-segment meter, then the licence server's answer. Approved, the token and licence go on.
 */
export function KeyStep({
  onActivate,
  onApproved,
}: {
  onActivate(key: string): Promise<KeyAnswer>;
  onApproved(token: string, licence: KeyLicence): void;
}) {
  // What the field shows: the grouped key, or, while someone is still typing the LUME prefix by hand, just that
  // (else its L would be read as the digit 1 before the E arrives).
  const [text, setText] = useState("");
  const raw = typedPrefix(text) ? "" : keyChars(text);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<KeyRefusal | null>(null);
  const full = raw.length === KEY_CHARS;
  const groups = Math.floor(raw.length / 4);
  const left = 5 - groups;
  const hint =
    raw.length === 0
      ? "Five groups of four. Dashes and spaces don’t matter."
      : full
        ? "Looks complete"
        : left === 1
          ? "1 more group to go"
          : `${left} more groups to go`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!full || busy) return;
    setBusy(true);
    setRefused(null);
    const r = await onActivate(displayKey(text));
    setBusy(false);
    if (r.ok) return onApproved(r.token, r.licence);
    setRefused(r.reason);
  }

  const amber = refused === "unreachable";
  return (
    <form method="post" onSubmit={submit} noValidate>
      <label htmlFor="product-key" className={k.label}>
        Product key
      </label>
      <div className={k.wrap} data-state={refused ? (amber ? "warn" : "error") : raw ? "on" : undefined}>
        <svg className={k.glyph} viewBox="0 0 24 24" aria-hidden>
          <circle cx="8" cy="15" r="4" />
          <path d="M10.85 12.15 19 4M17 6l2.5 2.5M14.5 8.5 16.5 10.5" />
        </svg>
        <input
          id="product-key"
          className={k.input}
          name="key"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="LUME-XXXX-XXXX-XXXX-XXXX-XXXX"
          value={text}
          readOnly={busy}
          aria-describedby="product-key-hint"
          aria-invalid={refused && !amber ? true : undefined}
          onChange={(e) => {
            setText(typedPrefix(e.target.value) ? e.target.value.toUpperCase() : displayKey(e.target.value));
            setRefused(null);
          }}
        />
      </div>
      <div id="product-key-hint" className={k.hint}>
        <span className={k.meter} aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} data-on={i < groups || undefined} />
          ))}
        </span>
        <span>{hint}</span>
      </div>
      {refused && (
        <p role="alert" className={k.alert} data-tone={amber ? "warn" : "error"}>
          <svg viewBox="0 0 16 16" aria-hidden>
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 4.8v3.6M8 11.2v.01" />
          </svg>
          <span>{REFUSAL_WORDS[refused]}</span>
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className={s.submit}
        disabled={!full || busy}
        aria-busy={busy || undefined}
      >
        {busy && <span className={k.spin} aria-hidden />}
        {busy ? "Checking with LUME…" : amber ? "Try again" : "Continue"}
      </Button>
      <div className={k.foot}>
        <span>Lost it? It’s in the message you were sent with your LUME’s address.</span>
        {refused && (
          <button
            type="button"
            className={k.link}
            onClick={() => {
              setText("");
              setRefused(null);
            }}
          >
            Use another key
          </button>
        )}
      </div>
    </form>
  );
}
