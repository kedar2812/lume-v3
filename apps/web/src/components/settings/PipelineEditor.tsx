"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { describeRule, type OnEnter } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Popover } from "@/components/ui/Popover";
import type { ApiResult } from "@/lib/api";
import { calendarClient } from "@/lib/calendar/client";
import { tokenColor } from "@/lib/leads/colors";
import type { FieldDefView, Person, Pipeline, Stage } from "@/lib/leads/types";
import { pipelinesClient, type StagePatch } from "@/lib/settings/pipelines";
import { accessGone } from "@/lib/settings/access";
import { templatesClient } from "@/lib/templates/client";
import { AccessChanged } from "./AccessChanged";
import { ColourPicker } from "./ColourPicker";
import { ListEditor } from "./ListEditor";
import {
  StageAutomations,
  newRule,
  type Moves,
  type NewRuleKind,
  type ReminderTemplate,
} from "./StageAutomations";
import a from "./automations.module.css";
import p from "./pipeline.module.css";
import s from "./settings.module.css";

const KINDS = [
  ["open", "Open"],
  ["won", "Won"],
  ["lost", "Lost"],
] as const;

type Note = { text: string; undo?: () => void; tone?: "problem" };
const sorted = (p: Pipeline) => [...p.stages].sort((a, b) => a.position - b.position);

const ADD: { type: NewRuleKind; label: string }[] = [
  { type: "create_task", label: "Set a follow-up" },
  { type: "notify", label: "Tell someone" },
  { type: "cancel_open_tasks", label: "Clear open follow-ups" },
  { type: "remind_before_meeting", label: "Remind the lead before their call" },
];

/**
 * A pipeline, simplified (canvas Pipeline, the owner's 2026-10-01 critique). The stages list holds only names
 * and colours, a quiet "2 automations", and the booking stage's Calendly mark; Won and Lost sit apart as
 * Outcomes. The chosen stage shows, beside it, its own settings and what LUME does when a lead enters it,
 * one line each. With Calendly connected, one sentence on top says where a booking moves its lead. Every
 * change saves as it is made; a refusal puts it back and says why.
 */
export function PipelineEditor({
  pipelines: initial,
  fields,
  people = [],
  calendly = false,
}: {
  pipelines: Pipeline[];
  fields: FieldDefView[];
  /** Who a stage's automations can name (3C). */
  people?: Person[];
  /** Calendly is connected (5D): the booking sentence shows. */
  calendly?: boolean;
}) {
  const [pipelines, setPipelines] = useState(initial);
  const [pipelineId, setPipelineId] = useState(initial.find((p) => p.isDefault)?.id ?? initial[0]?.id);
  const [note, setNote] = useState<Note | null>(null);
  const [archiving, setArchiving] = useState<Stage | null>(null);
  const [automating, setAutomating] = useState<{ stage: Stage; adding?: NewRuleKind } | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ReminderTemplate[]>([]);
  // The reminder messages a meeting reminder may send (4A's "reminder" templates).
  useEffect(() => {
    void templatesClient.list().then((r) => {
      if (r.ok)
        setTemplates(
          r.data.templates
            .filter((t) => t.category === "reminder" && t.usable)
            .map((t) => ({ id: t.id, name: t.name, body: t.body })),
        );
    });
  }, []);

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

  /** A stage's automations, saved with it (3C): LUME's words back when refused. */
  const saveAutomations = async (
    stage: Stage,
    onEnter: OnEnter,
    moves: Partial<Moves>,
  ): Promise<string | null> => {
    const r = await pipelinesClient.patchStage(stage.id, { onEnter, ...moves });
    if (!r.ok) {
      if (accessGone(r)) setForbidden(true);
      return r.message || "Those automations couldn’t be saved.";
    }
    setPipelines((all) =>
      all.map((p) => ({
        ...p,
        stages: p.stages.map((x) => (x.id === stage.id ? { ...x, ...r.data.stage, onEnter, ...moves } : x)),
      })),
    );
    setNote({ text: `Saved what ${stage.name} does` });
    return null;
  };
  const names = new Map(people.map((p) => [p.id, p.active ? p.name : `${p.name} (no longer active)`]));
  const stageName = new Map(stages.map((x) => [x.id, x.name]));
  /** What a stage does, as sentences: its moves after a message or a reply (4A), then its automations. */
  const doing = (x: Stage) => [
    ...(x.afterSentStageId
      ? [`After a message is sent: moves to ${stageName.get(x.afterSentStageId) ?? "another stage"}`]
      : []),
    ...(x.afterReplyStageId
      ? [`After a reply: moves to ${stageName.get(x.afterReplyStageId) ?? "another stage"}`]
      : []),
    ...(x.onEnter?.rules ?? []).map((r) => describeRule(r, names)),
  ];

  const needable = fields.filter((f) => !f.archived && f.key !== "name");
  const open = stages.filter((x) => x.kind === "open");
  const outcomes = stages.filter((x) => x.kind !== "open");
  const chosen = stages.find((x) => x.id === selected) ?? open[0] ?? stages[0]!;
  const count = (x: Stage) => doing(x).length;

  const setBooking = async (stageId: string | null) => {
    setNote(null);
    const r = await calendarClient.bookingStage(pipeline.id, stageId);
    if (!landed(r)) return;
    replacePipeline({ ...pipeline, bookingStageId: r.data.pipeline.bookingStageId });
    setNote({
      text: stageId ? "Bookings now move their lead there" : "Bookings leave their lead where it is",
    });
  };

  const stageRow = (stage: Stage) => (
    <span className={p.rowExtra}>
      {pipeline.bookingStageId === stage.id && (
        <img
          className={p.calendlyMark}
          src="/brand/calendly.svg"
          alt="Calendly's booking stage"
          width={16}
          height={16}
        />
      )}
      <button
        type="button"
        className={p.open}
        data-chosen={stage.id === chosen.id || undefined}
        aria-label={`Open ${stage.name}`}
        aria-pressed={stage.id === chosen.id}
        onClick={() => setSelected(stage.id)}
      >
        <span>{count(stage) ? `${count(stage)} automation${count(stage) === 1 ? "" : "s"}` : ""}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path
            d="M6 3.5 10.5 8 6 12.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </span>
  );

  const dot = (stage: Stage) => (
    <i className={p.dot} style={{ background: tokenColor(stage.color) }} aria-hidden />
  );

  return (
    <div className={s.stack}>
      {pipelines.length > 1 && (
        <label className={s.inlineSelect}>
          <span>Pipeline</span>
          <select value={pipeline.id} onChange={(e) => setPipelineId(e.target.value)}>
            {pipelines.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {calendly && (
        <div role="group" aria-label="Calendly bookings" className={p.booking}>
          <img src="/brand/calendly.svg" alt="" width={26} height={26} />
          <label htmlFor="booking-stage">
            When someone books a call through Calendly, LUME moves their lead to
          </label>
          <select
            id="booking-stage"
            aria-label="Booking stage"
            value={pipeline.bookingStageId ?? ""}
            onChange={(e) => void setBooking(e.target.value || null)}
          >
            <option value="">Leave it where it is</option>
            {open.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <Link href="/settings/integrations/calendly" className={p.bookingLink}>
            Calendly settings
          </Link>
        </div>
      )}
      <div className={p.layout}>
        <section className={p.lists} aria-labelledby="stages-head">
          <div className={p.listsHead}>
            <h3 id="stages-head" className={s.panelTitle}>
              Stages
            </h3>
            <span className={p.hint}>Drag to reorder</span>
          </div>
          <ListEditor
            listLabel="Stages"
            items={open.map((x) => ({ ...x, label: x.name }))}
            itemLabel="Stage"
            addLabel="Add a stage"
            onAdd={(name) => void add(name)}
            onRename={(id, name) =>
              rename(
                stages.find((x) => x.id === id)!,
                name,
              )
            }
            onReorder={(ids) => void reorder([...ids, ...outcomes.map((x) => x.id)])}
            askToArchive={(id) => setArchiving(stages.find((x) => x.id === id) ?? null)}
            renderExtra={stageRow}
            leading={dot}
          />
          <h4 className={p.outcomesHead}>Outcomes</h4>
          <ListEditor
            listLabel="Outcomes"
            items={outcomes.map((x) => ({ ...x, label: x.name }))}
            itemLabel="Stage"
            addLabel="Add an outcome"
            onRename={(id, name) =>
              rename(
                stages.find((x) => x.id === id)!,
                name,
              )
            }
            onReorder={(ids) => void reorder([...open.map((x) => x.id), ...ids])}
            askToArchive={(id) => setArchiving(stages.find((x) => x.id === id) ?? null)}
            renderExtra={stageRow}
            leading={dot}
          />
        </section>

        <section className={p.detail} aria-labelledby="chosen-stage">
          <h3 id="chosen-stage" className={p.chosenTitle}>
            <i className={p.dot} style={{ background: tokenColor(chosen.color) }} aria-hidden />
            {chosen.name}
          </h3>
          <div className={p.controls}>
            <div className={p.ctl}>
              <span aria-hidden>Colour</span>
              <ColourPicker
                label={`Colour for ${chosen.name}`}
                value={chosen.color}
                onChange={(color) => void patch(chosen, { color })}
              />
            </div>
            <div className={p.ctl}>
              <span aria-hidden>Kind</span>
              <select
                className={s.kind}
                aria-label={`Kind of ${chosen.name}`}
                value={chosen.kind}
                data-kind={chosen.kind}
                onChange={(e) => void patch(chosen, { kind: e.target.value as Stage["kind"] })}
              >
                {KINDS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className={p.ctl}>
              <span aria-hidden>Before it enters</span>
              <Popover
                label={`Needs for ${chosen.name}`}
                triggerClassName={s.needsBtn}
                align="end"
                active={chosen.requiredFieldIds.length > 0}
                trigger={
                  <>
                    <span aria-hidden>
                      {chosen.requiredFieldIds.length
                        ? `${chosen.requiredFieldIds.length} field${chosen.requiredFieldIds.length === 1 ? "" : "s"}`
                        : "Nothing"}
                    </span>
                    <span className={s.srOnly}>Needs for {chosen.name}</span>
                  </>
                }
              >
                <fieldset className={s.needs}>
                  <legend>Before a lead enters {chosen.name}, it needs</legend>
                  {needable.map((f) => (
                    <label key={f.id} className={s.check}>
                      <input
                        type="checkbox"
                        checked={chosen.requiredFieldIds.includes(f.id)}
                        onChange={(e) =>
                          void patch(chosen, {
                            requiredFieldIds: e.target.checked
                              ? [...chosen.requiredFieldIds, f.id]
                              : chosen.requiredFieldIds.filter((id) => id !== f.id),
                          })
                        }
                      />
                      {f.label}
                    </label>
                  ))}
                </fieldset>
              </Popover>
            </div>
            <div className={p.ctl}>
              <span aria-hidden>Overdue after</span>
              <SlaInput
                key={chosen.id}
                stage={chosen}
                onSave={(slaHours) => void patch(chosen, { slaHours })}
              />
            </div>
          </div>
          <p className={p.lede}>When a lead enters {chosen.name}, LUME does this on its own.</p>
          {doing(chosen).length ? (
            <ul className={p.automations} aria-label={`What ${chosen.name} does`}>
              {doing(chosen).map((line, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className={p.automation}
                    onClick={() => setAutomating({ stage: chosen })}
                  >
                    <span className={p.autoIcon} aria-hidden>
                      {line.startsWith("Sets the lead's owner a WhatsApp") ? (
                        <img src="/brand/whatsapp.svg" alt="" width={16} height={16} />
                      ) : (
                        <svg viewBox="0 0 16 16" width="14" height="14">
                          <path
                            d="M3.5 8.5 6.5 11.5 12.5 4.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </span>
                    <span>{line}</span>
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                      <path
                        d="M6 3.5 10.5 8 6 12.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>Nothing yet. Leads enter {chosen.name} and LUME leaves them be.</p>
          )}
          <div className={p.detailActions}>
            <Popover
              label="Add an automation"
              role="menu"
              triggerClassName={p.addBtn}
              trigger="Add an automation"
            >
              {(close) => (
                <div className={a.menu}>
                  {ADD.map((x) => {
                    const present =
                      x.type === "remind_before_meeting" &&
                      (chosen.onEnter?.rules ?? []).some((r) => r.type === "remind_before_meeting");
                    const noTemplate = x.type === "remind_before_meeting" && templates.length === 0;
                    return (
                      <button
                        key={x.type}
                        type="button"
                        role="menuitem"
                        className={a.menuItem}
                        disabled={present || noTemplate || (chosen.onEnter?.rules.length ?? 0) >= 5}
                        title={
                          present
                            ? "This stage already reminds the lead"
                            : noTemplate
                              ? "Write a reminder message in Templates first"
                              : undefined
                        }
                        onClick={() => {
                          close();
                          setAutomating({ stage: chosen, adding: x.type });
                        }}
                      >
                        {x.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </Popover>
            <button type="button" className={p.change} onClick={() => setAutomating({ stage: chosen })}>
              Change what {chosen.name} does
            </button>
          </div>
        </section>
      </div>
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
      {automating && (
        <StageAutomations
          stage={automating.stage}
          rules={[
            ...(automating.stage.onEnter?.rules ?? []),
            ...(automating.adding ? [newRule(automating.adding, templates[0]?.id)] : []),
          ]}
          moves={{
            afterSentStageId: automating.stage.afterSentStageId ?? null,
            afterReplyStageId: automating.stage.afterReplyStageId ?? null,
          }}
          // Never Lost: it always needs a reason, which a send or a reply can't give.
          targets={stages.filter((x) => x.id !== automating.stage.id && x.kind !== "lost")}
          people={people}
          templates={templates}
          onSave={(onEnter, moves) => saveAutomations(automating.stage, onEnter, moves)}
          onClose={() => setAutomating(null)}
        />
      )}
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
