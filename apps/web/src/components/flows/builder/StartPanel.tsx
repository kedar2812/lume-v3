"use client";
import { useRef, useState } from "react";
import { flowsClient, withoutId, type FlowTrigger } from "@/lib/flows/client";
import s from "./builder.module.css";

const KINDS: [FlowTrigger["kind"], string][] = [
  ["comment", "Comments on a post"],
  ["dm", "Sends a message"],
  ["story_reply", "Replies to a story"],
  ["story_mention", "Mentions you in a story"],
  ["ad", "Messages from an ad"],
  ["welcome", "Messages for the first time"],
];
/** The kinds a keyword can start: the rest start on their own. */
const WORDED = new Set<FlowTrigger["kind"]>(["comment", "dm"]);
const blank = (kind: FlowTrigger["kind"]): FlowTrigger => ({
  kind,
  accountId: null,
  keywords: [],
  mode: WORDED.has(kind) ? "word" : "any",
  mediaIds: [],
  adIds: [],
  publicReplies: [],
  cooldownHours: 24,
  enabled: true,
});
/** Keywords typed with commas: trimmed, each once (case aside, as the live match reads them), at most 50. */
const words = (v: string) => {
  const seen = new Set<string>();
  return v
    .split(",")
    .map((w) => w.trim())
    .filter((w) => {
      const k = w.toLocaleLowerCase();
      if (!w || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 50);
};
/** The longest keyword the server keeps. */
const KEYWORD_MAX = 100;
/** A way in as it's compared and sent: the server's ids are its own (new on every save), never sent back. */
const plain = withoutId;
export type TriggerDraft = { list: FlowTrigger[]; texts: string[] };

/**
 * Starts when (plan 2026-11-23-flow-builder, Task B2): what starts the flow, each way in with its keywords, saved with
 * Save (it changes who answers what, so never mid-typing), and the keyword tester: would these words start this flow,
 * and which other flows they'd start too.
 */
export function StartPanel({
  flowId,
  triggers,
  draft,
  onDraft,
  onSave,
  onClose,
}: {
  flowId: string;
  /** What's saved. */
  triggers: FlowTrigger[];
  /** Changes not saved yet: kept by the builder, so closing the panel never loses them (review 2026-11-24). */
  draft: TriggerDraft | null;
  onDraft: (d: TriggerDraft | null) => void;
  onSave: (t: FlowTrigger[]) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
}) {
  const list = draft?.list ?? triggers.map(plain);
  const texts = draft?.texts ?? triggers.map((t) => t.keywords.join(", "));
  const latest = useRef(draft);
  latest.current = draft;
  const edit = (f: (d: TriggerDraft) => TriggerDraft) => {
    const d = f(latest.current ?? { list, texts });
    latest.current = d;
    onDraft(d);
  };
  const setList = (f: (l: FlowTrigger[]) => FlowTrigger[]) => edit((d) => ({ ...d, list: f(d.list) }));
  const setTexts = (f: (x: string[]) => string[]) => edit((d) => ({ ...d, texts: f(d.texts) }));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [probe, setProbe] = useState("");
  const [result, setResult] = useState<null | {
    starts: boolean;
    keyword: string | null;
    overlaps: { flowId: string; name: string; keyword: string }[];
  }>(null);
  const changed = draft !== null && JSON.stringify(list) !== JSON.stringify(triggers.map(plain));
  const tooLong = list.some(
    (t) => WORDED.has(t.kind) && t.mode !== "any" && t.keywords.some((k) => k.length > KEYWORD_MAX),
  );

  const set = (i: number, t: FlowTrigger) => setList((l) => l.map((x, j) => (j === i ? t : x)));
  const save = async () => {
    const sent = latest.current;
    setBusy(true);
    setSaid(null);
    const r = await onSave(list);
    setBusy(false);
    setSaid(r.ok ? "Saved." : (r.message ?? "LUME couldn't save that. Try again."));
    // Saved: the panel shows what the server has now, unless it was changed again while saving.
    if (r.ok && latest.current === sent) onDraft(null);
  };
  /** Each way in is tried as it reads words (its own keywords, its own match); one says yes, and it starts. */
  const test = async () => {
    const worded = list.filter((t) => t.enabled && WORDED.has(t.kind));
    const asks = worded.length
      ? worded.map((t) => ({ keywords: t.mode === "any" ? [] : t.keywords, mode: t.mode }))
      : [{ keywords: [] as string[], mode: "word" as const }];
    const once = [...new Map(asks.map((a) => [JSON.stringify(a), a])).values()];
    const rs = await Promise.all(once.map((a) => flowsClient.testKeyword({ text: probe, ...a, flowId })));
    const bad = rs.find((r) => !r.ok);
    if (bad && !bad.ok) {
      setResult(null);
      setSaid(bad.message);
      return;
    }
    const data = rs.flatMap((r) => (r.ok ? [r.data] : []));
    const hit = data.find((d) => d.starts);
    const overlaps = [...new Map(data.flatMap((d) => d.overlaps).map((o) => [o.flowId, o])).values()];
    setResult({ starts: !!hit, keyword: hit?.keyword ?? null, overlaps });
  };
  /** With more than one way in, each control says which one it's for. */
  const nth = (label: string, i: number) => (list.length > 1 ? `${label}, way in ${i + 1}` : label);

  return (
    <aside className={s.insp} aria-label="Starts when" data-tool>
      <div className={s.ih}>
        <b className={s.ihTitle}>Starts when</b>
        <button type="button" className={s.x} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className={s.ib}>
        {list.map((t, i) => (
          <div key={i} className={s.ruleBox}>
            <div className={s.row}>
              <select
                className={s.input}
                aria-label={nth("Starts when someone", i)}
                value={t.kind}
                onChange={(e) => {
                  const kind = e.target.value as FlowTrigger["kind"];
                  // The keywords are what the box shows, so the two never disagree (review 2026-11-24).
                  set(i, {
                    ...blank(kind),
                    keywords: WORDED.has(kind) ? words(texts[i] ?? "") : [],
                    // What wasn't changed stays: the account it's on (none is every account), its cooldown, on or off.
                    accountId: t.accountId,
                    cooldownHours: t.cooldownHours,
                    enabled: t.enabled,
                  });
                }}
              >
                {KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={s.x}
                aria-label={nth("Remove this way in", i)}
                onClick={() => {
                  setList((l) => l.filter((_, j) => j !== i));
                  setTexts((x) => x.filter((_, j) => j !== i));
                }}
              >
                ×
              </button>
            </div>
            {WORDED.has(t.kind) && (
              <>
                <select
                  className={s.input}
                  aria-label={nth("Which words", i)}
                  value={t.mode}
                  onChange={(e) => {
                    const mode = e.target.value as FlowTrigger["mode"];
                    // Whatever the words: no keywords go; back to keywords, they're what the box shows.
                    set(i, { ...t, mode, keywords: mode === "any" ? [] : words(texts[i] ?? "") });
                  }}
                >
                  <option value="word">When the words include a keyword</option>
                  <option value="exact">When the words are exactly a keyword</option>
                  <option value="any">Whatever the words</option>
                </select>
                {t.mode !== "any" && (
                  <label className={s.field}>
                    <span className={s.lbl}>
                      Keywords <span>commas between them</span>
                      {list.length > 1 && <span className={s.srOnly}>, way in {i + 1}</span>}
                    </span>
                    <input
                      className={s.input}
                      value={texts[i] ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTexts((x) => x.map((y, j) => (j === i ? v : y)));
                        set(i, { ...t, keywords: words(v) });
                      }}
                    />
                  </label>
                )}
              </>
            )}
            {t.kind === "comment" && (
              <label className={s.field}>
                <span className={s.lbl}>
                  A public reply under the comment <span>optional</span>
                  {list.length > 1 && <span className={s.srOnly}>, way in {i + 1}</span>}
                </span>
                <input
                  className={s.input}
                  maxLength={300}
                  value={t.publicReplies[0] ?? ""}
                  onChange={(e) =>
                    set(i, { ...t, publicReplies: e.target.value.trim() ? [e.target.value] : [] })
                  }
                />
              </label>
            )}
            <label className={s.check}>
              <input
                type="checkbox"
                aria-label={nth("On", i)}
                checked={t.enabled}
                onChange={() => set(i, { ...t, enabled: !t.enabled })}
              />
              On
            </label>
          </div>
        ))}
        {list.length < 20 && (
          <button
            type="button"
            className={s.add}
            onClick={() => {
              setList((l) => [...l, blank("comment")]);
              setTexts((x) => [...x, ""]);
            }}
          >
            + Add a way in
          </button>
        )}
        <div className={s.row}>
          <button
            type="button"
            className={s.saveBtn}
            disabled={!changed || busy || tooLong}
            onClick={() => void save()}
          >
            Save
          </button>
          {/* Always there, so a screen reader hears what's said in it. */}
          <span className={s.said} role="status">
            {said}
          </span>
        </div>

        {tooLong && <span className={s.hint}>A keyword can be up to {KEYWORD_MAX} characters.</span>}

        <div className={s.group}>
          <span className={s.lbl}>Try some words</span>
          <div className={s.row}>
            <input
              className={s.input}
              aria-label="Words to try"
              placeholder="What someone might write"
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && probe.trim()) void test();
              }}
            />
            <button
              type="button"
              className={s.ghostBtnPlain}
              disabled={!probe.trim()}
              onClick={() => void test()}
            >
              Try
            </button>
          </div>
          <div aria-live="polite">
            {result && (
              <div className={s.lim}>
                <p data-ok={result.starts || undefined}>
                  {result.starts
                    ? result.keyword
                      ? `Starts this flow (the keyword "${result.keyword}").`
                      : "Starts this flow."
                    : "Doesn't start this flow."}
                </p>
                {result.overlaps.map((o) => (
                  <p
                    key={o.flowId}
                  >{`Would also start "${o.name}" (${o.keyword}). The flow with the higher priority answers.`}</p>
                ))}
              </div>
            )}
          </div>
          {changed && (
            <span className={s.hint}>
              The tester reads what&apos;s saved for other flows and what&apos;s here for this one.
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
