"use client";
import { useState } from "react";
import { MediaPicker } from "@/components/media/MediaPicker";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Popover } from "@/components/ui/Popover";
import { PriceList, type PriceDraft } from "./PriceList";
import s from "./ai.module.css";

export type KnowsDraft = {
  about: string;
  faqs: { key: string; q: string; a: string }[];
  prices: PriceDraft[];
  files: { id: string; name: string; archived: boolean }[];
  neverSay: { key: string; text: string }[];
};

const key = () => crypto.randomUUID();
const X = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** A file chosen for LUME AI, by its content: the thumbnail Media made, or the document mark while there's none. */
function FileThumb({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={s.thumb} aria-hidden>
      {failed ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M7 3h7l5 5v13H7z" />
          <path d="M14 3v5h5" />
        </svg>
      ) : (
        <img src={`/api/v1/files/${id}/thumb`} alt="" loading="lazy" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/**
 * Settings → LUME AI, What LUME AI knows (Autopilot spec 2026-10-19 §5): the business in its own words, its questions and
 * answers, its price list, the files from Media it may send, and what it must never say.
 */
export function KnowsSection({
  value: v,
  currency,
  onChange,
}: {
  value: KnowsDraft;
  currency: string;
  onChange(v: KnowsDraft): void;
}) {
  const set = (patch: Partial<KnowsDraft>) => onChange({ ...v, ...patch });

  return (
    <div className={s.knows}>
      <Field label="About your business" hint="What you do, for whom, where, and what makes you different.">
        {(c) => (
          <textarea
            {...c}
            className={s.textarea}
            rows={4}
            maxLength={2000}
            value={v.about}
            onChange={(e) => set({ about: e.target.value })}
          />
        )}
      </Field>

      <section className={s.block} aria-labelledby="ai-faqs">
        <h3 id="ai-faqs" className={s.blockTitle}>
          Questions people ask
        </h3>
        {v.faqs.map((f, i) => (
          <div key={f.key} role="group" aria-label={`Question ${i + 1}`} className={s.faq}>
            <input
              className={s.input}
              aria-label={`Question ${i + 1}`}
              placeholder="Do you visit the site before quoting?"
              maxLength={300}
              value={f.q}
              onChange={(e) =>
                set({ faqs: v.faqs.map((x) => (x.key === f.key ? { ...x, q: e.target.value } : x)) })
              }
            />
            <textarea
              className={s.textarea}
              aria-label={`Answer ${i + 1}`}
              placeholder="Your answer, as you'd say it"
              rows={2}
              maxLength={1000}
              value={f.a}
              onChange={(e) =>
                set({ faqs: v.faqs.map((x) => (x.key === f.key ? { ...x, a: e.target.value } : x)) })
              }
            />
            <button
              type="button"
              className={s.remove}
              aria-label={`Remove question ${i + 1}`}
              onClick={() => set({ faqs: v.faqs.filter((x) => x.key !== f.key) })}
            >
              {X}
            </button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={v.faqs.length >= 50}
          onClick={() => set({ faqs: [...v.faqs, { key: key(), q: "", a: "" }] })}
        >
          Add a question
        </Button>
      </section>

      <section className={s.block} aria-labelledby="ai-prices">
        <h3 id="ai-prices" className={s.blockTitle}>
          Price list
        </h3>
        <p className={s.blockLede}>In {currency}. LUME AI quotes only these.</p>
        <PriceList rows={v.prices} currency={currency} onChange={(prices) => set({ prices })} />
      </section>

      <section className={s.block} aria-labelledby="ai-files">
        <h3 id="ai-files" className={s.blockTitle}>
          Files it may send
        </h3>
        <p className={s.blockLede}>Brochures, past work, price sheets: sent as the real file, from Media.</p>
        <ul className={s.files} aria-label="Files LUME AI may send">
          {v.files.map((f) => (
            <li key={f.id} aria-label={f.name} className={s.file} data-archived={f.archived || undefined}>
              <FileThumb id={f.id} />
              <span className={s.fileText}>
                <b>{f.name}</b>
                {f.archived && <span>Archived in Media</span>}
              </span>
              <button
                type="button"
                className={s.remove}
                aria-label={`Remove ${f.name}`}
                onClick={() => set({ files: v.files.filter((x) => x.id !== f.id) })}
              >
                {X}
              </button>
            </li>
          ))}
        </ul>
        {v.files.length < 50 && (
          <Popover
            label="Choose from Media"
            trigger="Choose from Media"
            triggerClassName={s.choose}
            size="form"
          >
            {(close) => (
              <MediaPicker
                multiple
                wide
                onPick={(picked) => {
                  const have = new Set(v.files.map((f) => f.id));
                  const added = picked
                    .filter((p) => !have.has(p.id))
                    .map((p) => ({ id: p.id, name: p.name, archived: false }));
                  set({ files: [...v.files, ...added].slice(0, 50) });
                  close();
                }}
              />
            )}
          </Popover>
        )}
      </section>

      <section className={s.block} aria-labelledby="ai-never">
        <h3 id="ai-never" className={s.blockTitle}>
          Never say
        </h3>
        <p className={s.blockLede}>Promises, words or topics LUME AI must leave alone.</p>
        {v.neverSay.map((n, i) => (
          <div key={n.key} className={s.line}>
            <input
              className={s.input}
              aria-label={`Never say, line ${i + 1}`}
              placeholder="We never promise a finish date before the site visit"
              maxLength={200}
              value={n.text}
              onChange={(e) =>
                set({
                  neverSay: v.neverSay.map((x) => (x.key === n.key ? { ...x, text: e.target.value } : x)),
                })
              }
            />
            <button
              type="button"
              className={s.remove}
              aria-label={`Remove line ${i + 1}`}
              onClick={() => set({ neverSay: v.neverSay.filter((x) => x.key !== n.key) })}
            >
              {X}
            </button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={v.neverSay.length >= 30}
          onClick={() => set({ neverSay: [...v.neverSay, { key: key(), text: "" }] })}
        >
          Add a line
        </Button>
      </section>
    </div>
  );
}
