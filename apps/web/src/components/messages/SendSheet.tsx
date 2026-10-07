"use client";
import { createPortal } from "react-dom";
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { render, type RenderContext, type TemplateCategory } from "@lume/core/shared";
import { useSound } from "@/components/feedback/SoundProvider";
import b from "@/components/ui/Button.module.css";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { leadsClient } from "@/lib/leads/client";
import { markAway, onBack, sheetShown } from "@/lib/messages/pending";
import { templatesClient, type TemplateView } from "@/lib/templates/client";
import { ordered } from "@/lib/templates/order";
import { TokenLine } from "@/components/templates/TokenLine";
import { SentPrompt, type Outcome } from "./SentPrompt";
import s from "./messages.module.css";
import { missingIn } from "@/lib/messages/missing";

const firstLine = (body: string) => body.split("\n").find((l) => l.trim()) ?? "";

type Choice = { kind: "template"; t: TemplateView } | { kind: "own" };

/**
 * WhatsApp from wherever a lead is (4A): the drawer, Today, the notification centre. A template renders in
 * the lead's own words into text that stays editable; Open WhatsApp hands off as before (a blank tab on the
 * click, pointed at the server's link once it's ready). Back in LUME, the Sent prompt asks how it went.
 */
export function SendSheet({
  lead,
  suggest,
  taskId,
  blocked,
  compact,
  align = "start",
  stageId,
  promptSlot,
  onChange,
  onSettled,
}: {
  lead: { id: string; name: string };
  suggest?: TemplateCategory;
  /** The follow-up it's sent from: Sent completes it. */
  taskId?: string;
  /** Why WhatsApp can't open for this lead, if it can't. */
  blocked?: string | null;
  /** An icon button, for a row. */
  compact?: boolean;
  align?: "start" | "end";
  /** The lead's stage as the screen knows it: once it's no longer where Sent put it, Undo goes. */
  stageId?: string;
  /** Where the Sent prompt takes a row of its own (the drawer); otherwise it floats from the button. */
  promptSlot?: HTMLElement | null;
  /** Something was logged or moved: history and stage may have changed. */
  onChange?: () => void;
  /** The prompt has gone; `sent` says how it ended. */
  onSettled?: (sent: boolean) => void;
}) {
  const sound = useSound();
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [flash, setFlash] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // One answer per question: a double-tap's second press finds it answered, however fast the server was.
  const answered = useRef(false);

  // "Sent?" rises when they're back after WhatsApp was opened from here (focus, the tab shown again, the
  // page restored). This sheet gone by then, the shell asks instead (PendingSent).
  const me = useRef(Symbol("send-sheet"));
  useEffect(() => sheetShown(me.current), []);
  useEffect(
    () =>
      onBack((p) => {
        if (p.by !== me.current) return;
        answered.current = false;
        setAsking(true);
      }),
    [],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  // The lead moved on since (a reply, a drag): undoing the send's move now would undo the wrong one. Still
  // where it came from means the screen hasn't caught up yet; where Sent put it means nothing changed.
  const moved = outcome?.moved && !outcome.undone ? outcome.moved : null;
  useEffect(() => {
    if (moved && stageId && stageId !== moved.stageId && stageId !== moved.fromStageId)
      setOutcome((o) => (o?.moved ? { ...o, moved: null } : o));
  }, [moved, stageId]);

  const settle = (sent: boolean, after: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOutcome(null);
      onSettled?.(sent);
    }, after);
  };

  const answer = async (sent: boolean) => {
    if (answered.current) return;
    answered.current = true;
    setAsking(false);
    if (sent) setOutcome({ pending: true });
    const r = await leadsClient.confirmMessage(lead.id, sent, taskId);
    onChange?.();
    if (!sent) return onSettled?.(false);
    if (!r.ok) {
      // Not logged: no tick, no chime, and a follow-up it came from stays (its row doesn't leave).
      setOutcome({ failed: r.message });
      return settle(false, 6000);
    }
    // Logged: the sound, the tick and the button's tint together, on the frame LUME knows it.
    sound.play("sent");
    setFlash(true);
    setTimeout(() => setFlash(false), 900);
    const said: Outcome = r.data.moved
      ? { moved: r.data.moved }
      : r.data.notMoved
        ? { refused: r.data.notMoved.message }
        : {};
    setOutcome(said);
    settle(true, said.moved || said.refused ? 6000 : 1600);
  };

  const undo = async () => {
    const moved = outcome?.moved;
    if (!moved) return;
    const r = await leadsClient.move(lead.id, moved.fromStageId);
    setOutcome(r.ok ? { moved, undone: true } : { failed: r.message });
    if (r.ok) onChange?.();
    settle(true, r.ok ? 1400 : 6000);
  };

  return (
    <div
      className={s.send}
      data-whatsapp
      data-sent={flash || undefined}
      // Asking or answering: a row that shows its actions only on hover keeps them shown (Today).
      data-live={asking || outcome ? true : undefined}
    >
      <span className={s.srOnly} aria-live="polite">
        {asking ? "Back from WhatsApp. Was the message sent?" : ""}
      </span>
      <Popover
        label={`WhatsApp ${lead.name}`}
        size="form"
        align={align}
        disabled={!!blocked}
        triggerClassName={compact ? s.icon : `${b.btn} ${b.whatsapp}`}
        {...(compact ? { triggerLabel: `WhatsApp ${lead.name}` } : {})}
        trigger={
          <>
            {/* WhatsApp's own mark, unmodified, on a white tile (public/brand/README.md) */}
            <span className={b.brandTile} aria-hidden>
              <img src="/brand/whatsapp.svg" alt="" width={14} height={14} />
            </span>
            {!compact && "WhatsApp"}
          </>
        }
      >
        {(close) => (
          <SheetBody
            lead={lead}
            {...(suggest ? { suggest } : {})}
            {...(taskId ? { taskId } : {})}
            onOpened={() => {
              close();
              setOutcome(null);
              markAway({
                leadId: lead.id,
                leadName: lead.name,
                ...(taskId ? { taskId } : {}),
                by: me.current,
              });
              onChange?.();
            }}
          />
        )}
      </Popover>
      {promptSlot
        ? createPortal(
            <SentPrompt
              inline
              asking={asking}
              outcome={outcome}
              onAnswer={(sent) => void answer(sent)}
              onUndo={() => void undo()}
            />,
            promptSlot,
          )
        : null}
      {!promptSlot && (
        <SentPrompt
          asking={asking}
          outcome={outcome}
          align={align}
          onAnswer={(sent) => void answer(sent)}
          onUndo={() => void undo()}
        />
      )}
    </div>
  );
}

function SheetBody({
  lead,
  suggest,
  taskId,
  onOpened,
}: {
  lead: { id: string; name: string };
  suggest?: TemplateCategory;
  taskId?: string;
  onOpened: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [ctx, setCtx] = useState<RenderContext | null>(null);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const id = useId();

  // The templates and this lead's words, fetched once as the sheet opens; every render after is local.
  useEffect(() => {
    let live = true;
    void Promise.all([templatesClient.list(), templatesClient.context(lead.id)]).then(([l, c]) => {
      if (!live) return;
      setTemplates(l.ok ? ordered(l.data.templates, suggest) : []);
      if (c.ok) setCtx(c.data);
      else setError(c.message);
    });
    return () => {
      live = false;
    };
  }, [lead.id, suggest]);

  const choices: Choice[] = [
    ...(templates ?? []).map((t) => ({ kind: "template" as const, t })),
    { kind: "own" },
  ];
  const pick = (c: Choice) => {
    setChosen(c);
    setText(c.kind === "own" ? "" : ctx ? render(c.t.body, ctx).text : c.t.body);
    requestAnimationFrame(() => textRef.current?.focus());
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : choices.length - 1);
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const c = choices[active];
      if (c) pick(c);
    }
  };

  const open = async () => {
    if (busy) return;
    setError(null);
    const tab = window.open("", "_blank");
    if (!tab) return setError("Your browser blocked the new tab. Allow pop-ups for LUME, then try again.");
    tab.opener = null;
    setBusy(true);
    const r = await leadsClient.prepareMessage(lead.id, text.trim(), {
      ...(chosen?.kind === "template" ? { templateVersionId: chosen.t.versionId } : {}),
      ...(taskId ? { taskId } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      tab.close();
      return setError(r.message);
    }
    tab.location.href = r.data.url;
    onOpened();
  };

  const missing = missingIn(text);
  const optionId = (i: number) => `${id}-o${i}`;
  // The active choice stays in view as the keys move it through a long list.
  useEffect(() => {
    if (templates) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId is stable for this sheet (it comes from useId).
  }, [active, templates]);
  return (
    <form
      method="post"
      className={s.sheet}
      onSubmit={(e) => {
        e.preventDefault();
        void open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void open();
        }
      }}
    >
      <div
        role="listbox"
        aria-label="Templates"
        tabIndex={0}
        className={s.list}
        aria-activedescendant={templates ? optionId(active) : undefined}
        aria-busy={!templates || undefined}
        onKeyDown={onListKey}
      >
        {templates === null ? (
          <>
            <span className={s.skeleton} />
            <span className={s.skeleton} />
          </>
        ) : (
          choices.map((c, i) => {
            const name = c.kind === "own" ? "Write your own" : c.t.name;
            const on =
              c.kind === "own"
                ? chosen?.kind === "own"
                : chosen?.kind === "template" && chosen.t.id === c.t.id;
            return (
              <div
                key={c.kind === "own" ? "own" : c.t.id}
                id={optionId(i)}
                role="option"
                aria-selected={on}
                data-name={name}
                data-active={i === active || undefined}
                className={s.option}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setActive(i);
                  pick(c);
                }}
              >
                <span className={s.optName}>{name}</span>
                {c.kind === "template" && (
                  <span className={s.optLine}>
                    <TokenLine text={firstLine(c.t.body)} fields={ctx?.fields ?? []} />
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <label htmlFor={`${id}-text`} className={s.label}>
        Message
      </label>
      <div className={s.field}>
        <div ref={ghost} className={s.ghost} aria-hidden>
          {marked(text)}
          {"\n"}
        </div>
        <textarea
          ref={textRef}
          id={`${id}-text`}
          rows={5}
          maxLength={4096}
          className={s.text}
          value={text}
          placeholder={`Hi ${lead.name.split(" ")[0] ?? ""},`}
          onChange={(e) => setText(e.target.value)}
          onScroll={(e) => {
            if (ghost.current) ghost.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      {missing.length > 0 && (
        <p className={s.missing}>Missing: {missing.join(", ")}. Fill it in, or LUME sends it as is.</p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      <Button type="submit" variant="whatsapp" className={s.primary} disabled={busy}>
        Open WhatsApp
      </Button>
      <p className={s.hint} aria-hidden>
        ↑↓ to choose · ↵ to use · {/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"} ↵ to open
      </p>
    </form>
  );
}

/** The words behind the textarea, with each gap underlined in amber where it sits. */
function marked(text: string): ReactNode[] {
  return text.split(/(\{\{[^{}]+\}\})/g).map((part, i) =>
    /^\{\{[^{}]+\}\}$/.test(part) ? (
      <mark key={i} data-missing className={s.gap}>
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
