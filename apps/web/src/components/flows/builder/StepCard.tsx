"use client";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { memo } from "react";
import type { GNode } from "@lume/core/shared";
import { exitsOfNode } from "./graph-edit";
import { exitWords, headline, KINDS, summary, waitWords, type StepKind } from "./kinds";
import { ICON_SIZE, STEP_ICONS } from "@/components/ui/icons";
import s from "./builder.module.css";

export type StepData = {
  node: GNode;
  /** Problems on this step (stops Publish), and warnings. */
  problems: number;
  /** The first problem's words, said on the card (owner 2026-11-28: a "!" alone said nothing). */
  say?: string | null;
  /** Numbers, when the Numbers view is on. */
  stats?: { entered: number; people: number; sent: number } | null;
  /** Just placed by LUME AI, not kept yet. */
  fresh?: boolean;
  /** The phone test has gone through it. */
  lit?: boolean;
};
export type StepNode = Node<StepData, "step">;

/** A step's icon: LUME's own for its kind (components/ui/icons.tsx). */
export function KindIcon({ kind }: { kind: StepKind }) {
  const Icon = STEP_ICONS[kind];
  return <Icon size={ICON_SIZE.md} aria-hidden />;
}

/** Long words shortened on the card, whole in the panel: never a line cut in half. */
const brief = (t: string, max: number) => {
  const c = [...t.trim()];
  return c.length > max
    ? `${c
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : t.trim();
};

/** What a step's card shows under its name, in the approved canvas's shapes. */
function Body({ n }: { n: GNode }) {
  switch (n.type) {
    case "message":
    case "ask":
    case "book":
      return n.text ? (
        <span className={s.bub}>
          <span className={s.clamp}>{brief(n.text, 180)}</span>
        </span>
      ) : (
        <span className={s.empty}>Nothing written yet</span>
      );
    case "wait":
      return (
        <span className={s.sent}>
          {"minutes" in n.for ? `Waits ${waitWords(n.for.minutes)}` : `Waits until ${n.for.until.time}`}
        </span>
      );
    case "notify":
      return n.text ? (
        <span className={s.sent}>{brief(n.text, 140)}</span>
      ) : (
        <span className={s.empty}>Nothing written yet</span>
      );
    case "handoff":
      return (
        <span className={s.sent}>
          {n.to === "ai" ? "LUME AI takes the conversation" : "A person takes the conversation"}
        </span>
      );
    case "end":
      return <span className={s.sent}>Nothing else is sent.</span>;
    default:
      return null;
  }
}

function StepCardImpl({ data, selected }: NodeProps<StepNode>) {
  const n = data.node;
  const kind = KINDS[n.type];
  const exits = exitsOfNode(n);
  const line = headline(n);
  return (
    <div
      className={s.nd}
      role="group"
      data-on={selected || undefined}
      data-fresh={data.fresh || undefined}
      data-lit={data.lit || undefined}
      data-problem={data.problems > 0 || undefined}
      aria-label={`Step: ${kind.label}, ${summary(n)}`}
    >
      <Handle type="target" position={Position.Left} id="in" className={s.pin} />
      <span className={s.nh}>
        <span className={s.nt}>
          <KindIcon kind={n.type} />
        </span>
        <span className={s.titles}>
          <span className={s.nk}>{kind.label}</span>
          {line && <span className={s.nn}>{line}</span>}
        </span>
        {data.fresh && <span className={s.newtag}>New</span>}
        {data.problems > 0 && (
          <span
            className={s.warn}
            role="img"
            aria-label={data.problems === 1 ? "1 problem" : `${data.problems} problems`}
            title={data.problems === 1 ? "1 problem" : `${data.problems} problems`}
          >
            !
          </span>
        )}
      </span>
      {data.problems > 0 && data.say && (
        <span className={s.say} title={data.say}>
          {data.say}
        </span>
      )}
      <span className={s.nb}>
        <Body n={n} />
        {exits.map((e) => (
          <span
            key={e.key}
            className={s.out}
            data-plain={e.key === "next" || e.key === "noAnswer" || undefined}
          >
            <span className={s.outLabel}>{exitWords(n, e)}</span>
            {e.to === null && <span className={s.ends}>Ends here</span>}
            <Handle
              type="source"
              position={Position.Right}
              id={e.key}
              className={s.port}
              data-loose={e.to === null || undefined}
            />
          </span>
        ))}
      </span>
      {data.stats && (
        <span className={s.stats}>
          <span>
            <span>Entered</span>
            <b>{data.stats.entered.toLocaleString("en-IN")}</b>
          </span>
          <span>
            <span>People</span>
            <b>{data.stats.people.toLocaleString("en-IN")}</b>
          </span>
          <span>
            <span>Sent</span>
            <b>{data.stats.sent.toLocaleString("en-IN")}</b>
          </span>
        </span>
      )}
    </div>
  );
}

/** Memoised: a card re-renders only when its own step changes, so a hundred steps pan and zoom smoothly. */
export const StepCard = memo(StepCardImpl);
