"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { FlowTrigger } from "@/lib/flows/client";
import { ICON_SIZE, TRIGGER_ICONS } from "@/components/ui/icons";
import s from "./builder.module.css";

export type StartData = { triggers: FlowTrigger[] };
export type StartNode = Node<StartData, "start">;

const WHAT: Record<FlowTrigger["kind"], string> = {
  comment: "Comments on a post",
  dm: "Sends a message",
  story_reply: "Replies to a story",
  story_mention: "Mentions you in a story",
  ad: "Messages from an ad",
  welcome: "Messages for the first time",
};

/** What starts it, drawn as it is everywhere in LUME (components/ui/icons.tsx). */
export function TriggerIcon({ kind }: { kind: FlowTrigger["kind"] }) {
  const Icon = TRIGGER_ICONS[kind];
  return <Icon size={ICON_SIZE.sm} className={s.trigIc} aria-hidden />;
}

/** Starts when: what starts the flow, each trigger with its keywords; its line goes to the first step. */
function StartCardImpl({ data, selected }: NodeProps<StartNode>) {
  const on = data.triggers.filter((t) => t.enabled);
  return (
    <div className={s.nd} role="group" data-on={selected || undefined} data-start aria-label="Starts when">
      <span className={s.nh}>
        <span className={s.nt} data-ig>
          <img src="/brand/instagram-glyph-black.svg" alt="" className={s.igLight} />
          <img src="/brand/instagram-glyph-white.svg" alt="" className={s.igDark} />
        </span>
        <span className={s.titles}>
          <span className={s.nk}>Starts when</span>
          <span className={s.nn}>
            {on.length ? `${on.length} ${on.length === 1 ? "way in" : "ways in"}` : "Choose what starts it"}
          </span>
        </span>
      </span>
      <span className={s.nb}>
        {on.map((t, i) => (
          <span key={t.id ?? i} className={s.trig}>
            <TriggerIcon kind={t.kind} />
            <span className={s.trigWhat}>{WHAT[t.kind]}</span>
            {t.mode !== "any" && t.keywords[0] && (
              <span className={s.kw} title={t.keywords.join(", ")}>
                {t.keywords[0]}
                {t.keywords.length > 1 ? ` +${t.keywords.length - 1}` : ""}
              </span>
            )}
          </span>
        ))}
        {!on.length && <span className={s.empty}>A keyword, a story reply, an ad or a first message</span>}
      </span>
      <Handle type="source" position={Position.Right} id="next" className={s.hport} />
    </div>
  );
}

export const StartCard = memo(StartCardImpl);
