"use client";
import { useId } from "react";
import type { LostReason, Stage } from "@/lib/leads/types";
import s from "./stagepick.module.css";

/** Where a log card leaves the lead: "" stays where it is, otherwise a stage id (and, for a lost one, the reason). */
export type StageChoice = { stageId: string; lostReasonId: string };
export const STAYS: StageChoice = { stageId: "", lostReasonId: "" };

/** The move a choice asks for, or null when the lead stays (a lost stage without its reason isn't a move yet). */
export function moveOf(
  choice: StageChoice,
  stages: Stage[],
): { stage: Stage; extra: { lostReasonId?: string } } | null {
  const stage = stages.find((x) => x.id === choice.stageId);
  if (!stage) return null;
  if (stage.kind === "lost")
    return choice.lostReasonId ? { stage, extra: { lostReasonId: choice.lostReasonId } } : null;
  return { stage, extra: {} };
}

/** The choice can be saved: it stays, or moves somewhere that needs nothing more, or it's lost with a reason. */
export const choiceReady = (choice: StageChoice, stages: Stage[]) =>
  choice.stageId === "" || moveOf(choice, stages) !== null;

/**
 * The Stage row of the log cards (Log outcome, Log a call; owner 2026-11-27: "allow moving lead to any pipeline stage
 * via the log cards"): every stage of the lead's pipeline in order, the one it's in first as "Stays in …". A lost stage
 * asks its reason right there, as every other move does.
 */
export function StagePick({
  first,
  stages,
  currentId,
  value,
  reasons,
  onChange,
}: {
  first: string;
  /** The lead's pipeline's stages, in order. */
  stages: Stage[];
  currentId: string;
  value: StageChoice;
  /** The lost reasons, once read (null while they're on their way). */
  reasons: LostReason[] | null;
  onChange: (c: StageChoice) => void;
}) {
  const id = useId();
  const current = stages.find((x) => x.id === currentId);
  const picked = stages.find((x) => x.id === value.stageId);
  return (
    <>
      <label className={s.row} htmlFor={`${id}-stage`}>
        <span>Stage</span>
        <select
          id={`${id}-stage`}
          value={value.stageId}
          onChange={(e) => onChange({ stageId: e.target.value, lostReasonId: "" })}
        >
          <option value="">{current ? `Stays in ${current.name}` : "Stays where it is"}</option>
          {stages
            .filter((x) => x.id !== currentId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      {picked?.kind === "lost" &&
        (reasons && reasons.length === 0 ? (
          <p className={s.hint}>There are no lost reasons yet. An admin can add them in Settings.</p>
        ) : (
          <label className={s.row} htmlFor={`${id}-why`}>
            <span>Why was {first || "this lead"} lost?</span>
            <select
              id={`${id}-why`}
              value={value.lostReasonId}
              disabled={!reasons}
              onChange={(e) => onChange({ ...value, lostReasonId: e.target.value })}
            >
              <option value="">Pick a reason</option>
              {(reasons ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        ))}
    </>
  );
}
