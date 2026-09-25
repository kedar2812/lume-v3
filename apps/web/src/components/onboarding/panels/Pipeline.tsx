"use client";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { tokenColor } from "@/lib/leads/colors";
import type { OnboardingActions, Pipeline, Stage } from "@/lib/onboarding-client";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

const KIND: Record<string, string> = { open: "Open", won: "Won", lost: "Lost" };

/** Rename in place (saved on blur) and reorder with buttons, so it works from the keyboard too. */
export function PipelinePanel({
  kicker,
  actions,
  isOwner,
}: {
  kicker: string;
  actions: Pick<OnboardingActions, "listPipeline" | "renameStage" | "reorderStages">;
  isOwner: boolean;
}) {
  const [pipeline, setPipeline] = useState<Pipeline | null | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void actions.listPipeline().then((p) => live && setPipeline(p));
    return () => {
      live = false;
    };
  }, [actions]);

  async function rename(stage: Stage) {
    const next = (drafts[stage.id] ?? stage.name).trim();
    setDrafts((d) => {
      const rest = { ...d };
      delete rest[stage.id];
      return rest;
    });
    if (!next || next === stage.name || !pipeline) return;
    const before = pipeline;
    setPipeline({
      ...pipeline,
      stages: pipeline.stages.map((x) => (x.id === stage.id ? { ...x, name: next } : x)),
    });
    if (!(await actions.renameStage(stage.id, next))) {
      setPipeline(before);
      setError(`“${next}” couldn’t be saved. Stage names must be unique in a pipeline.`);
    } else setError(null);
  }

  async function move(index: number, by: -1 | 1) {
    if (!pipeline) return;
    const stages = [...pipeline.stages];
    const [moved] = stages.splice(index, 1);
    stages.splice(index + by, 0, moved!);
    const before = pipeline;
    setPipeline({ ...pipeline, stages });
    if (
      !(await actions.reorderStages(
        pipeline.id,
        stages.map((x) => x.id),
      ))
    ) {
      setPipeline(before);
      setError("That order couldn’t be saved. Try again.");
    } else setError(null);
  }

  return (
    <>
      <PanelHead
        kicker={kicker}
        title={isOwner ? "Check your pipeline" : "Your pipeline"}
        lead="These are the stages every lead moves through. Rename or reorder them now, or leave them and adjust in Settings any time. Changes apply to everyone."
      />
      {pipeline === undefined ? (
        <div className={s.pipe} aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={40} radius={11} />
          ))}
        </div>
      ) : pipeline === null ? (
        <p className={s.inlineNote}>There’s no pipeline yet. You can create one in Settings.</p>
      ) : (
        <ol className={s.pipe} aria-label={pipeline.name}>
          {pipeline.stages.map((st, i) => (
            <li key={st.id} className={s.stageRow}>
              <span className={s.dot} style={{ background: tokenColor(st.color) }} aria-hidden />
              <input
                aria-label={`Stage ${i + 1} name`}
                className={s.stageName}
                value={drafts[st.id] ?? st.name}
                maxLength={60}
                onChange={(e) => setDrafts((d) => ({ ...d, [st.id]: e.target.value }))}
                onBlur={() => void rename(st)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <span className={s.kind}>{KIND[st.kind] ?? st.kind}</span>
              <button
                type="button"
                className={s.move}
                aria-label={`Move ${st.name} up`}
                disabled={i === 0}
                onClick={() => void move(i, -1)}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                  <path
                    d="M3 7.5 6 4.5l3 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className={s.move}
                aria-label={`Move ${st.name} down`}
                disabled={i === pipeline.stages.length - 1}
                onClick={() => void move(i, 1)}
              >
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                  <path
                    d="M3 4.5 6 7.5l3-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className={s.alert}>
          {error}
        </p>
      )}
    </>
  );
}
