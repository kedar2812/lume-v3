"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";
import k from "@/components/sheets/sheets.module.css";
import { PRESET_LABEL } from "@/lib/webhooks/format";
import type { WebhookPreset } from "@/lib/webhooks/types";
import w from "./webhooks.module.css";

const HINT: Record<WebhookPreset, string> = {
  website: "Your site's own form, posting from your server.",
  zapier: "A Zap that sends each new lead on.",
  make: "A Make scenario that sends each new lead on.",
  manychat: "Instagram and Messenger chats, from an External Request.",
};

/** A neutral mark: LUME has no official files for these yet, and draws no one's logo. */
export function PresetGlyph({ large = false }: { large?: boolean }) {
  const px = large ? 20 : 15;
  return (
    <span className={large ? `${w.glyph} ${w.glyphLarge}` : w.glyph} aria-hidden>
      <svg viewBox="0 0 16 16" width={px} height={px}>
        <path
          d="M8 2.5v7m0 0L5 6.5m3 3 3-3M3 11v1.5c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** Step 1 (spec §6): where the posts will come from, and a name for them. */
export function WhereFromStep({
  manychat,
  busy,
  onCreate,
}: {
  manychat: boolean;
  busy: boolean;
  onCreate(o: { preset: WebhookPreset; name: string }): void;
}) {
  const presets = (Object.keys(PRESET_LABEL) as WebhookPreset[]).filter((p) => p !== "manychat" || manychat);
  const [preset, setPreset] = useState<WebhookPreset>("website");
  const [name, setName] = useState(PRESET_LABEL.website);
  const [named, setNamed] = useState(false);
  const choose = (p: WebhookPreset) => {
    setPreset(p);
    if (!named) setName(PRESET_LABEL[p]); // the name follows the choice until someone types their own
  };
  return (
    <>
      <section className={s.body}>
        <h3 className={s.stepTitle}>Where will leads come from?</h3>
        <p className={s.lede}>
          LUME gives you an address to post each new lead to. Pick the closest match; the steps after fit it.
        </p>
        <fieldset className={w.presets}>
          <legend>Sends from</legend>
          {presets.map((p) => (
            <label key={p} className={w.preset}>
              <input type="radio" name="preset" checked={preset === p} onChange={() => choose(p)} />
              <PresetGlyph />
              <span className={w.presetName}>{PRESET_LABEL[p]}</span>
              <small>{HINT[p]}</small>
            </label>
          ))}
        </fieldset>
        <label className={k.field}>
          <span>Name</span>
          <input
            className={s.input}
            value={name}
            maxLength={120}
            onChange={(e) => {
              setNamed(true);
              setName(e.target.value);
            }}
          />
        </label>
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>Nothing comes in until you've seen a test post.</p>
        <Button
          variant="primary"
          loading={busy}
          disabled={!name.trim()}
          onClick={() => onCreate({ preset, name: name.trim() })}
        >
          Create webhook
        </Button>
      </footer>
    </>
  );
}
