"use client";
import { displayKey } from "@lume/core/shared";
import type { KeyRefusal } from "@/lib/setup-client";

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
export const typedPrefix = (v: string) => {
  const alnum = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return alnum.length > 0 && "LUME".startsWith(alnum);
};

/** What a product key field shows for what was typed: the grouped key, or the LUME prefix as typed so far. */
export const keyFieldValue = (v: string): string => (typedPrefix(v) ? v.toUpperCase() : displayKey(v));
