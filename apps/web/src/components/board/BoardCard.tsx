"use client";
import { motion, useReducedMotion } from "motion/react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { tokenColor } from "@/lib/leads/colors";
import { formatMoney, personName } from "@/lib/leads/format";
import type { Catalog, Lead, Stage } from "@/lib/leads/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./board.module.css";

const DAY = 86_400_000;

/** "Today", "1 day", "12 days" — how long the lead has waited in this stage. */
export function inStage(lead: Lead, now = Date.now()): string {
  if (!lead.stageEnteredAt) return "";
  const days = Math.floor((now - new Date(lead.stageEnteredAt).getTime()) / DAY);
  return days <= 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`;
}

/** What a card shows. Shared by the card in its column and the copy that follows the pointer. */
export function CardFace({ lead, catalog }: { lead: Lead; catalog: Catalog }) {
  const owner = personName(catalog, lead.ownerId);
  return (
    <>
      <span className={s.cardName}>{lead.name ?? "Unnamed lead"}</span>
      <span className={s.cardMeta}>
        {lead.value ? (
          <span className={s.cardValue}>{formatMoney(lead.value, lead.currency ?? catalog.currency)}</span>
        ) : null}
        <span className={s.cardAge} data-volatile>
          {inStage(lead)}
        </span>
        <span className={s.cardOwner} title={owner}>
          <Avatar name={owner} size={20} />
        </span>
      </span>
    </>
  );
}

/**
 * One lead on the board. A click opens it; Space picks it up for a keyboard move; a pointer drag (for
 * those who may move it) lifts a copy that follows the pointer while this one waits, dimmed, in place.
 */
export function BoardCard({
  lead,
  stage,
  catalog,
  picked,
  ghost,
  onOpen,
  onKeyDown,
  onPointerDown,
}: {
  lead: Lead;
  stage: Stage;
  catalog: Catalog;
  /** Picked up with the keyboard. */
  picked: boolean;
  /** Being dragged: the real card is elsewhere, following the pointer. */
  ghost: boolean;
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type="button"
      layout={!ghost}
      layoutId={ghost ? undefined : lead.id}
      transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
      data-lead-card={lead.id}
      data-picked={picked || undefined}
      data-ghost={ghost || undefined}
      aria-roledescription="draggable lead"
      aria-describedby="board-help"
      className={s.card}
      style={{ ["--c" as string]: tokenColor(stage.color) }}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        // Space on a button clicks on key-up; on a card Space means "pick up", never "open".
        if (e.key === " ") e.preventDefault();
      }}
      onPointerDown={onPointerDown}
    >
      <CardFace lead={lead} catalog={catalog} />
    </motion.button>
  );
}
