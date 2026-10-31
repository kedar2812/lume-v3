"use client";
import { TEMPLATE_CATEGORIES, type FieldType } from "@lume/core/shared";
import { useId, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { templatesClient, type TemplateDraft } from "@/lib/templates/client";
import { TokenLine } from "./TokenLine";
import s from "./draft.module.css";

const MAX = 500;
/** Where people usually start: one tap fills the request, which they can then change. */
const STARTERS = [
  { label: "Thank a new enquiry", prompt: "Thank someone who just enquired and invite them to a short call" },
  { label: "Follow up after no reply", prompt: "Follow up with leads who haven't replied in a few days" },
  { label: "Remind about a visit", prompt: "Remind a lead about their booked visit and ask them to confirm" },
  { label: "Win back an old lead", prompt: "Reconnect with a lead who went quiet a month ago, warmly, without pressure" },
] as const;
const categoryLabel = (key: string) => TEMPLATE_CATEGORIES.find((c) => c.key === key)?.label ?? key;

type State =
  | { is: "asking" }
  | { is: "writing" }
  | { is: "ready"; options: TemplateDraft[] }
  | { is: "none" }
  | { is: "error"; message: string };

/**
 * Write with LUME AI (owner, 2026-10-31): the person says what the template is for, LUME AI writes two or three takes
 * LUME could send as written, each with when it works best, and Use this opens one in the editor to change, save and
 * submit for WhatsApp's approval as any template is. Nothing is saved here.
 */
export function DraftWithAi({
  fields,
  onUse,
  onClose,
}: {
  fields: { key: string; type: FieldType; label?: string }[];
  onUse(d: TemplateDraft): void;
  onClose(): void;
}) {
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<State>({ is: "asking" });
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const writing = state.is === "writing";
  const ready = prompt.trim().length > 0 && !writing;

  const write = async () => {
    if (!ready) return;
    setState({ is: "writing" });
    const r = await templatesClient.draft(prompt.trim());
    if (!r.ok) return setState({ is: "error", message: r.message });
    setState(r.data.options.length ? { is: "ready", options: r.data.options } : { is: "none" });
  };

  return (
    <Dialog label="Write with LUME AI" onClose={onClose} width={720} className={s.sheet}>
      <header className={s.head}>
        <span className={s.mark} aria-hidden>
          <AiGlyph size={22} draw={writing ? "pen" : "loop"} />
        </span>
        <div>
          <h2 className={s.title}>Write with LUME AI</h2>
          <p className={s.lede}>Say what the template is for. LUME AI writes a few to choose from, in your voice.</p>
        </div>
      </header>

      <label htmlFor={`${id}-ask`} className={s.label}>
        What should this template do?
      </label>
      <div className={s.ask}>
        <textarea
          ref={area}
          id={`${id}-ask`}
          className={s.input}
          rows={3}
          maxLength={MAX}
          value={prompt}
          placeholder="Follow up with people who asked for prices and went quiet"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void write();
            }
          }}
        />
        <div className={s.askFoot}>
          <div className={s.starters} aria-label="Starting points" role="group">
            {STARTERS.map((st) => (
              <button
                key={st.label}
                type="button"
                className={s.starter}
                onClick={() => {
                  setPrompt(st.prompt);
                  area.current?.focus();
                }}
              >
                {st.label}
              </button>
            ))}
          </div>
          <Button variant="primary" disabled={!ready} loading={writing} onClick={() => void write()}>
            Write templates
          </Button>
        </div>
      </div>

      <div className={s.results} aria-live="polite">
        {writing && (
          <>
            <p className={s.status}>LUME AI is writing…</p>
            <div className={s.cards} aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className={`${s.card} ${s.ghost}`}>
                  <span />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          </>
        )}
        {state.is === "error" && (
          <p role="alert" className={s.error}>
            {state.message}
          </p>
        )}
        {state.is === "none" && (
          <p className={s.status}>LUME AI couldn&apos;t write one LUME could send for that. Try saying it another way.</p>
        )}
        {state.is === "ready" && (
          <>
            <div className={s.cards}>
              {state.options.map((o) => (
                <article key={o.name} className={s.card} aria-label={o.name}>
                  <div className={s.cardHead}>
                    <b className={s.cardName}>{o.name}</b>
                    <span className={s.category}>{categoryLabel(o.category)}</span>
                  </div>
                  <p className={s.body}>
                    <TokenLine text={o.body} fields={fields} />
                  </p>
                  <p className={s.why}>{o.why}</p>
                  <Button size="sm" className={s.use} onClick={() => onUse(o)}>
                    Use this
                  </Button>
                </article>
              ))}
            </div>
            <p className={s.hint}>
              Use this opens it in the editor, to change, save and send for WhatsApp&apos;s approval.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
