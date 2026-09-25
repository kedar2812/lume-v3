"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Popover } from "@/components/ui/Popover";
import type { ApiResult } from "@/lib/api";
import { tokenColor } from "@/lib/leads/colors";
import type { FieldDefView, Pipeline, Stage } from "@/lib/leads/types";
import { pipelinesClient, type StagePatch } from "@/lib/settings/pipelines";
import { accessGone } from "@/lib/settings/access";
import { AccessChanged } from "./AccessChanged";
import { ColourPicker } from "./ColourPicker";
import { ListEditor } from "./ListEditor";
import s from "./settings.module.css";

const KINDS = [
  ["open", "Open"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;

type Note = { text: string; undo?: () => void; tone?: "problem" };
const sorted = (p: Pipeline) => [...p.stages].sort((a, b) => a.position - b.position);

/**
 * A pipeline's stages, edited in place: rename, recolour, reorder, say what kind each is, which fields
 * a lead needs before entering it and how long it may sit there. Every change saves as it is made; a
 * refusal puts the stage back and says why. Archiving asks where the stage's leads go.
 */
export function PipelineEditor({
  pipelines: initial,
  fields,
}: {
  pipelines: Pipeline[];
  fields: FieldDefView[];
}) {
  const [pipelines, setPipelines] = useState(initial);
  const [pipelineId, setPipelineId] = useState(initial.find((p) => p.isDefault)?.id ?? initial[0]?.id);
  const [note, setNote] = useState<Note | null>(null);
  const [archiving, setArchiving] = useState<Stage | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const pipeline = pipelines.find((p) => p.id === pipelineId);
  if (forbidden) return <AccessChanged />;
  if (!pipeline) return <p className={s.muted}>There’s no pipeline yet.</p>;
  const stages = sorted(pipeline);

  const setStages = (next: Stage[]) =>
    setPipelines((all) => all.map((p) => (p.id === pipeline.id ? { ...p, stages: next } : p)));
  const replacePipeline = (next: Pipeline) =>
    setPipelines((all) => all.map((p) => (p.id === next.id ? next : p)));

  /** Whether a result went through; a refusal is said out loud, and a 403 means access changed. */
  const landed = <T,>(r: ApiResult<T>): r is Extract<ApiResult<T>, { ok: true }> => {
    if (r.ok) return true;
    if (accessGone(r)) setForbidden(true);
    else setNote({ text: r.message || "That change couldn’t be saved.", tone: "problem" });
    return false;
  };

  const patch = async (stage: Stage, change: StagePatch, saved: Note = { text: "Saved" }) => {
    const before = stages;
    setStages(stages.map((x) => (x.id === stage.id ? { ...x, ...change } : x)));
    setNote(null);
    const r = await pipelinesClient.patchStage(stage.id, change);
    if (!landed(r)) return setStages(before);
    setPipelines((all) =>
      all.map((p) => ({
        ...p,
        stages: p.stages.map((x) => (x.id === stage.id ? { ...x, ...r.data.stage } : x)),
      })),
    );
    setNote(saved);
  };

  const reorder = async (ids: string[]) => {
    const before = stages;
    setStages(ids.map((id, position) => ({ ...stages.find((x) => x.id === id)!, position })));
    const r = await pipelinesClient.reorder(pipeline.id, ids);
    if (!landed(r)) return setStages(before);
    replacePipeline(r.data.pipeline);
    setNote({ text: "Saved" });
  };

  const add = async (name: string) => {
    setNote(null);
    const r = await pipelinesClient.addStage(pipeline.id, { name, kind: "open" });
    if (!landed(r)) return;
    // A new open stage belongs before the outcomes, not after Lost.
    const ids = stages.map((x) => x.id);
    const at = stages.findIndex((x) => x.kind !== "open");
    ids.splice(at < 0 ? ids.length : at, 0, r.data.stage.id);
    setStages([...stages, r.data.stage]);
    await reorder(ids);
  };

  const rename = (stage: Stage, name: string) =>
    void patch(
      stage,
      { name },
      { text: `Renamed to ${name}`, undo: () => void patch({ ...stage, name }, { name: stage.name }) },
    );

  const archive = async (stage: Stage, moveTo: string) => {
    const r = await pipelinesClient.archiveStage(stage.id, moveTo);
    setArchiving(null);
    if (!landed(r)) return;
    const fresh = await pipelinesClient.list();
    if (landed(fresh)) setPipelines(fresh.data.pipelines);
    setNote({ text: `${stage.name} archived; its leads moved` });
  };

  const needable = fields.filter((f) => !f.archived && f.key !== "name");

  return (
    <div className={s.stack}>
      {pipelines.length > 1 && (
        <label className={s.inlineSelect}>
          <span>Pipeline</span>
          <select value={pipeline.id} onChange={(e) => setPipelineId(e.target.value)}>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ListEditor
        items={stages.map((x) => ({ ...x, label: x.name }))}
        itemLabel="Stage"
        addLabel="Add a stage"
        onAdd={(name) => void add(name)}
        onRename={(id, name) =>
          rename(
            stages.find((x) => x.id === id)!,
            name,
          )
        }
        onReorder={(ids) => void reorder(ids)}
        askToArchive={(id) => setArchiving(stages.find((x) => x.id === id) ?? null)}
        renderExtra={(stage) => (
          <div className={s.extras}>
            <ColourPicker
              label={`Colour for ${stage.name}`}
              value={stage.color}
              onChange={(color) => void patch(stage, { color })}
            />
            <select
              className={s.kind}
              aria-label={`Kind of ${stage.name}`}
              value={stage.kind}
              data-kind={stage.kind}
              onChange={(e) => void patch(stage, { kind: e.target.value as Stage["kind"] })}
            >
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <Popover
              label={`Needs for ${stage.name}`}
              triggerClassName={s.needsBtn}
              align="end"
              active={stage.requiredFieldIds.length > 0}
              trigger={
                <>
                  <span aria-hidden>
                    Needs{stage.requiredFieldIds.length ? ` ${stage.requiredFieldIds.length}` : ""}
                  </span>
                  <span className={s.srOnly}>Needs for {stage.name}</span>
                </>
              }
            >
              <fieldset className={s.needs}>
                <legend>Before a lead enters {stage.name}, it needs</legend>
                {needable.map((f) => (
                  <label key={f.id} className={s.check}>
                    <input
                      type="checkbox"
                      checked={stage.requiredFieldIds.includes(f.id)}
                      onChange={(e) =>
                        void patch(stage, {
                          requiredFieldIds: e.target.checked
                            ? [...stage.requiredFieldIds, f.id]
                            : stage.requiredFieldIds.filter((id) => id !== f.id),
                        })
                      }
                    />
                    {f.label}
                  </label>
                ))}
              </fieldset>
            </Popover>
            <SlaInput stage={stage} onSave={(slaHours) => void patch(stage, { slaHours })} />
          </div>
        )}
      />
      {note &&
        (note.tone === "problem" ? (
          <p role="alert" className={s.problem}>
            {note.text}
          </p>
        ) : (
          <p role="status" className={s.saved}>
            {note.text}
            {note.undo && (
              <button
                type="button"
                className={s.undo}
                onClick={() => {
                  const undo = note.undo!;
                  setNote(null);
                  undo();
                }}
              >
                Undo
              </button>
            )}
          </p>
        ))}
      {archiving && (
        <ArchiveStage
          stage={archiving}
          targets={stages.filter((x) => x.kind === "open" && x.id !== archiving.id)}
          onCancel={() => setArchiving(null)}
          onArchive={(moveTo) => void archive(archiving, moveTo)}
        />
      )}
    </div>
  );
}

/** Hours a lead may sit in a stage; saved when the field is left, empty for no limit. */
function SlaInput({ stage, onSave }: { stage: Stage; onSave: (hours: number | null) => void }) {
  const [text, setText] = useState(stage.slaHours ? String(stage.slaHours) : "");
  const commit = () => {
    const t = text.trim();
    const hours = t === "" ? null : Math.round(Number(t));
    if (hours !== null && !(hours >= 1 && hours <= 24 * 365))
      return setText(stage.slaHours ? String(stage.slaHours) : "");
    if (hours !== (stage.slaHours ?? null)) onSave(hours);
  };
  return (
    <label className={s.sla} title="Hours a lead may sit here before it’s overdue">
      <input
        type="number"
        min={1}
        max={24 * 365}
        inputMode="numeric"
        placeholder="—"
        aria-label={`Hours allowed in ${stage.name}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <span aria-hidden>h</span>
    </label>
  );
}

/** Where an archived stage's leads go: another open stage of the same pipeline, chosen on purpose. */
function ArchiveStage({
  stage,
  targets,
  onCancel,
  onArchive,
}: {
  stage: Stage;
  targets: Stage[];
  onCancel: () => void;
  onArchive: (moveTo: string) => void;
}) {
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog label={`Archive ${stage.name}?`} onClose={onCancel}>
      <h2 className={s.dialogTitle}>Archive {stage.name}?</h2>
      {targets.length ? (
        <>
          <p className={s.dialogText}>
            Its leads move to the stage you choose. Their history keeps {stage.name}.
          </p>
          <div role="radiogroup" aria-label="Move its leads to" className={s.targets}>
            {targets.map((t) => (
              <label key={t.id} className={s.target}>
                <input
                  type="radio"
                  name="move-to"
                  aria-label={t.name}
                  checked={to === t.id}
                  onChange={() => setTo(t.id)}
                />
                <span className={s.swatch} style={{ background: tokenColor(t.color) }} aria-hidden />
                <span aria-hidden>{t.name}</span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <p className={s.dialogText}>
          This is the only open stage. Add another first, so its leads have somewhere to go.
        </p>
      )}
      <div className={s.dialogActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={!to || busy}
          onClick={() => {
            setBusy(true);
            onArchive(to!);
          }}
        >
          Archive and move its leads
        </Button>
      </div>
    </Dialog>
  );
}
