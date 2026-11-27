"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { metaColumns, type LiveSheetPreset, type LiveSheetRule } from "@lume/core/shared";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { availableColumns, DEFAULT_COLUMNS } from "@/lib/leads/columns";
import type { Catalog } from "@/lib/leads/types";
import { liveSheetsClient, type GoogleAccount, type LiveSheetView } from "@/lib/live-sheets/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useLiveSheets } from "@/lib/notifications/stream";
import { CopyLink } from "./CopyLink";
import { SheetProgress } from "./SheetProgress";
import s from "./live-sheets.module.css";

/** Where the form waits while Google asks for permission (the relay leaves the page). */
export const DRAFT_KEY = "lume.liveSheetDraft";
const STEPS = 4;
const n = (v: number) => v.toLocaleString("en-US");
const META_WORDS: Record<string, string> = {
  email: "The lead's email",
  phone: "The phone with its country code, digits only",
  fn: "First name",
  ln: "Last name",
  country: "Two-letter country, from the phone",
  value: "The won value, for value-based lookalikes",
};

export type Prefill = { stageIds?: string[]; sourceIds?: string[]; tagIds?: string[]; ownerIds?: string[] };
type Draft = {
  preset: LiveSheetPreset;
  mode: "reached" | "in";
  stageIds: string[];
  sourceId: string;
  tagId: string;
  ownerId: string;
  addedOnOrAfter: string;
  includeMissing: boolean;
  includeDnc: boolean;
  dncTouched: boolean;
  backfill: boolean;
  order: string[];
  chosen: string[];
  name: string;
  nameTouched: boolean;
  edits: "keep" | "replace";
};

function startDraft(
  catalog: Catalog,
  contactsVisible: boolean,
  prefill?: Prefill,
  editing?: LiveSheetView,
): Draft {
  const cols = availableColumns(catalog, contactsVisible).map((c) => c.id);
  if (editing) {
    const chosen =
      editing.preset === "own" ? editing.columns : DEFAULT_COLUMNS.filter((c) => cols.includes(c));
    return {
      preset: editing.preset,
      mode: editing.rule.stages.mode,
      stageIds: editing.rule.stages.stageIds,
      sourceId: editing.rule.sourceIds?.[0] ?? "",
      tagId: editing.rule.tagIds?.[0] ?? "",
      ownerId: editing.rule.ownerIds?.[0] ?? "",
      addedOnOrAfter: editing.rule.addedOnOrAfter ?? "",
      includeMissing: editing.rule.includeMissing,
      includeDnc: editing.rule.includeDnc,
      dncTouched: true,
      backfill: editing.rule.backfill,
      order: [...chosen, ...cols.filter((c) => !chosen.includes(c))],
      chosen,
      name: editing.name,
      nameTouched: true,
      edits: editing.edits,
    };
  }
  const chosen = DEFAULT_COLUMNS.filter((c) => cols.includes(c));
  return {
    preset: "meta",
    mode: "reached",
    stageIds: prefill?.stageIds ?? [],
    sourceId: prefill?.sourceIds?.[0] ?? "",
    tagId: prefill?.tagIds?.[0] ?? "",
    ownerId: prefill?.ownerIds?.[0] ?? "",
    addedOnOrAfter: "",
    includeMissing: true,
    includeDnc: false,
    dncTouched: false,
    backfill: true,
    order: [...chosen, ...cols.filter((c) => !chosen.includes(c))],
    chosen,
    name: "",
    nameTouched: false,
    edits: "keep",
  };
}

function ruleOf(d: Draft): LiveSheetRule {
  return {
    stages: { mode: d.mode, stageIds: d.stageIds },
    ...(d.sourceId ? { sourceIds: [d.sourceId] } : {}),
    ...(d.tagId ? { tagIds: [d.tagId] } : {}),
    ...(d.ownerId ? { ownerIds: [d.ownerId] } : {}),
    ...(d.addedOnOrAfter ? { addedOnOrAfter: d.addedOnOrAfter } : {}),
    includeMissing: d.includeMissing,
    includeDnc: d.includeDnc,
    backfill: d.backfill,
  };
}

/**
 * Make or edit a live sheet (spec 2026-11-14 §2): four short steps over the whole window. What it's for, which leads,
 * which columns, then a name, what happens to edits made in the sheet, and the Google account. Making it turns the
 * last step into the bar, which follows the sheet to Live and its link. Closing never stops the work.
 */
export function CreateLiveSheet({
  catalog,
  contactsVisible,
  prefill,
  editing,
  resume,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  contactsVisible: boolean;
  prefill?: Prefill;
  editing?: LiveSheetView;
  /** Back from Google's permission screen: the form as it was, at its last step. */
  resume?: { draft: Draft; grantId?: string };
  onClose(): void;
  onSaved(sheet: LiveSheetView): void;
}) {
  const reduce = !!useReducedMotion();
  const [d, setD] = useState<Draft>(
    () => resume?.draft ?? startDraft(catalog, contactsVisible, prefill, editing),
  );
  const [step, setStep] = useState(resume ? STEPS - 1 : 0);
  const [dir, setDir] = useState(1);
  const [count, setCount] = useState<{ matching: number; missingContact: number } | null>(null);
  const [grants, setGrants] = useState<GoogleAccount[] | null>(null);
  const [grantId, setGrantId] = useState(resume?.grantId ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [made, setMade] = useState<LiveSheetView | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const stages = useMemo(
    () => catalog.pipelines.flatMap((p) => p.stages.map((st) => ({ ...st, pipeline: p.name }))),
    [catalog],
  );
  const stageName = (id: string) => stages.find((x) => x.id === id)?.name ?? "";
  const columns = useMemo(() => availableColumns(catalog, contactsVisible), [catalog, contactsVisible]);
  const includesWon = d.stageIds.some((id) => stages.find((x) => x.id === id)?.kind === "won");
  const rule = useMemo(() => ruleOf(d), [d]);

  // The name follows the first stage chosen until the person types their own.
  const suggested = d.stageIds[0] ? `${stageName(d.stageIds[0])} leads` : "";
  const name = d.nameTouched ? d.name : suggested;

  // Do-not-contact: left out of a Meta audience, kept in a list of one's own, until the person chooses.
  useEffect(() => {
    if (!d.dncTouched) set({ includeDnc: d.preset === "own" });
  }, [d.preset, d.dncTouched]);

  // The count, a moment after the rule settles.
  const ruleKey = JSON.stringify([d.preset, rule]);
  useEffect(() => {
    if (!d.stageIds.length) return setCount(null);
    let live = true;
    const t = setTimeout(() => {
      void liveSheetsClient.count(d.preset, rule).then((r) => live && r?.ok && setCount(r.data));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ruleKey]);

  useEffect(() => {
    if (editing || grants) return;
    void liveSheetsClient.grants().then((r) => {
      if (!r?.ok) return setGrants([]);
      setGrants(r.data.grants);
      setGrantId((g) => g || r.data.grants[0]?.id || "");
    });
  }, [editing, grants]);

  useEffect(() => heading.current?.focus(), [step]);

  // Made: follow it to Live (the stream, and a look every few seconds in case the stream is away).
  const follow = async () => {
    if (!made) return;
    const r = await liveSheetsClient.get(made.id);
    if (r?.ok) setMade(r.data.sheet);
  };
  useLiveSheets((e) => {
    if (made && (e.sheet === made.id || e.sheet === "*")) void follow();
  });
  useEffect(() => {
    if (!made || made.status === "live" || made.status === "paused") return;
    const t = setInterval(() => void follow(), 4000);
    return () => clearInterval(t);
  }, [made?.id, made?.status]);

  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setProblem(null);
    setStep(to);
  };
  const canNext =
    step === 1 ? d.stageIds.length > 0 : step === 2 ? d.preset === "meta" || d.chosen.length > 0 : true;
  const ordered = d.order.filter((id) => d.chosen.includes(id));
  const body = {
    name: name.trim(),
    preset: d.preset,
    rule,
    columns: d.preset === "own" ? ordered : [],
    edits: d.edits,
  };

  const save = async () => {
    setBusy(true);
    setProblem(null);
    if (editing) {
      const r = await liveSheetsClient.edit(editing.id, body);
      setBusy(false);
      if (!r.ok) return setProblem(r.message);
      onSaved(r.data.sheet);
      return onClose();
    }
    const r = await liveSheetsClient.create({ ...body, grantId });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setMade(r.data.sheet);
  };

  const connect = async () => {
    setBusy(true);
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ draft: { ...d, name, nameTouched: true }, at: Date.now() }),
      );
    } catch {
      // A private window: the form starts again when it's back, nothing worse.
    }
    const r = await liveSheetsClient.connectStart();
    if (!r.ok) {
      setBusy(false);
      return setProblem(r.message);
    }
    window.location.assign(r.data.url);
  };

  const enter = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15 } }
    : {
        initial: { opacity: 0, x: dir * 28 },
        animate: { opacity: 1, x: 0 },
        transition: toMotion(SPRINGS.default),
      };
  const label = editing ? "Edit live sheet" : "Create a live sheet";

  if (made)
    return (
      <Dialog label={label} onClose={onClose} width={620}>
        <div className={s.form}>
          <div className={s.formHead}>
            <span />
            <h2 ref={heading} tabIndex={-1}>
              {made.status === "live" ? "Your live sheet is ready" : "Making your live sheet"}
            </h2>
            <span />
          </div>
          <div className={s.done}>
            <p className={s.lede}>
              {made.status === "live"
                ? `“${made.name}” is in your Google Drive, and LUME keeps it up to date.`
                : "LUME is making it in your Google Drive. You can close this: it carries on, and Live sheets shows how far it's got."}
            </p>
            {made.status === "paused" ? (
              <p role="alert" className={s.problem}>
                {made.pauseReason === "google_disconnected"
                  ? "LUME couldn't reach your Google account. Connect Google again from Live sheets."
                  : "LUME couldn't finish the sheet. Live sheets says why."}
              </p>
            ) : (
              <SheetProgress
                phase={
                  made.status === "live"
                    ? "live"
                    : made.lastError
                      ? "slow"
                      : (made.run?.total ?? 0) > 0
                        ? "writing"
                        : "making"
                }
                total={made.run?.total ?? made.leadCount}
                written={made.run?.written ?? made.leadCount}
                count={made.leadCount}
              />
            )}
            {made.url && <CopyLink url={made.url} />}
          </div>
          <div className={s.foot}>
            <span className={s.grow} />
            <Button
              variant="primary"
              onClick={() => {
                onSaved(made);
                onClose();
              }}
            >
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    );

  return (
    <Dialog label={label} onClose={busy ? () => undefined : onClose} width={620}>
      <div className={s.form}>
        <div className={s.formHead}>
          <button
            type="button"
            className={s.back}
            aria-label="Back"
            hidden={step === 0}
            onClick={() => go(step - 1)}
          >
            <UI_ICONS.back size={ICON_SIZE.md} aria-hidden />
          </button>
          <h2 ref={heading} tabIndex={-1}>
            {
              [
                "What it's for",
                "Which leads",
                "Which columns",
                editing ? "Name and edits" : "Name, edits and Google",
              ][step]
            }
          </h2>
          <span className={s.stepCount}>
            Step {step + 1} of {STEPS}
          </span>
        </div>
        <div className={s.dots} aria-hidden>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} data-on={i <= step || undefined} />
          ))}
        </div>

        <motion.div key={step} className={s.stepBody} {...enter}>
          {step === 0 && (
            <>
              <p className={s.lede}>
                A live sheet is a Google Sheet LUME keeps up to date with the leads you choose. What will it
                be used for?
              </p>
              <div role="radiogroup" aria-label="What it's for" className={s.choices}>
                <Choice
                  on={d.preset === "meta"}
                  onPick={() => set({ preset: "meta" })}
                  title="For a Meta audience"
                  badge="Recommended for ads"
                >
                  Columns in the format Meta&apos;s customer list takes: email, phone, name and country.
                </Choice>
                <Choice on={d.preset === "own"} onPick={() => set({ preset: "own" })} title="My own columns">
                  Any of your lead fields, in the order you like.
                </Choice>
              </div>
              {d.preset === "meta" && (
                <p className={s.consent}>
                  Upload only people who agreed to hear from you. Meta&apos;s terms ask for it.
                </p>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <SegmentedControl
                label="Which leads"
                value={d.mode}
                onChange={(mode) => set({ mode })}
                options={[
                  { value: "reached", label: "Reached a stage" },
                  { value: "in", label: "In a stage now" },
                ]}
              />
              <p className={s.lede}>
                {d.mode === "reached"
                  ? "Every lead that ever got to these stages stays in the sheet, even after it moves on."
                  : "A live list of who's in these stages right now: a lead that moves on leaves the sheet."}
              </p>
              {catalog.pipelines.map((p) => (
                <div key={p.id} className={s.group}>
                  {catalog.pipelines.length > 1 && <span>{p.name}</span>}
                  <div className={s.stagePick} role="group" aria-label={`Stages in ${p.name}`}>
                    {p.stages.map((st) => {
                      const on = d.stageIds.includes(st.id);
                      return (
                        <button
                          key={st.id}
                          type="button"
                          className={s.stageChip}
                          aria-pressed={on}
                          onClick={() =>
                            set({
                              stageIds: on ? d.stageIds.filter((x) => x !== st.id) : [...d.stageIds, st.id],
                            })
                          }
                        >
                          {st.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className={s.narrow}>
                <label>
                  Source
                  <select value={d.sourceId} onChange={(e) => set({ sourceId: e.target.value })}>
                    <option value="">Any source</option>
                    {catalog.sources.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Tag
                  <select value={d.tagId} onChange={(e) => set({ tagId: e.target.value })}>
                    <option value="">Any tag</option>
                    {catalog.tags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Owner
                  <select value={d.ownerId} onChange={(e) => set({ ownerId: e.target.value })}>
                    <option value="">Anyone</option>
                    {catalog.people
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Added on or after
                  <input
                    type="date"
                    value={d.addedOnOrAfter}
                    onChange={(e) => set({ addedOnOrAfter: e.target.value })}
                  />
                </label>
              </div>
              <div>
                <Toggle
                  label="Include leads from before today"
                  hint="Off: only leads that match from now on."
                  checked={d.backfill}
                  onChange={(backfill) => set({ backfill })}
                />
                {d.preset === "meta" && (
                  <Toggle
                    label="Include leads with no phone or email"
                    hint="Their empty cells are shaded, so they're easy to see. Meta can't match them."
                    checked={d.includeMissing}
                    onChange={(includeMissing) => set({ includeMissing })}
                  />
                )}
                <Toggle
                  label="Include do-not-contact leads"
                  hint={
                    d.preset === "meta"
                      ? "Left out by default: they asked not to hear from you."
                      : "They're in the list as any lead."
                  }
                  checked={d.includeDnc}
                  onChange={(includeDnc) => set({ includeDnc, dncTouched: true })}
                />
              </div>
              {count && (
                <p className={s.count} aria-live="polite">
                  <strong>{n(count.matching)}</strong> {count.matching === 1 ? "lead matches" : "leads match"}{" "}
                  today
                  {d.preset === "meta" && count.missingContact > 0 && (
                    <span>
                      · {n(count.missingContact)} have no phone or email{d.includeMissing ? "" : ", left out"}
                    </span>
                  )}
                </p>
              )}
            </>
          )}

          {step === 2 &&
            (d.preset === "meta" ? (
              <>
                <p className={s.lede}>
                  Meta&apos;s own column names, so it can match the people in the sheet.
                </p>
                <ul className={s.meta}>
                  {metaColumns(includesWon).map((c) => (
                    <li key={c}>
                      <code>{c}</code>
                      {META_WORDS[c]}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <p className={s.lede}>
                  Tick the columns the sheet has, and move them into the order you like. The name comes first.
                </p>
                <ul className={s.columns} aria-label="Columns">
                  {d.order.map((id, i) => {
                    const c = columns.find((x) => x.id === id);
                    if (!c) return null;
                    const on = d.chosen.includes(id);
                    const fixed = id === "name";
                    return (
                      <li key={id} className={s.column} data-off={!on || undefined}>
                        <input
                          type="checkbox"
                          aria-label={c.label}
                          checked={on || fixed}
                          disabled={fixed}
                          onChange={() =>
                            set({ chosen: on ? d.chosen.filter((x) => x !== id) : [...d.chosen, id] })
                          }
                        />
                        <span>{c.label}</span>
                        <button
                          type="button"
                          className={s.move}
                          aria-label={`Move ${c.label} up`}
                          disabled={fixed || i <= 1}
                          onClick={() => set({ order: swap(d.order, i, i - 1) })}
                        >
                          <UI_ICONS.moveUp size={ICON_SIZE.sm} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className={s.move}
                          aria-label={`Move ${c.label} down`}
                          disabled={fixed || i >= d.order.length - 1}
                          onClick={() => set({ order: swap(d.order, i, i + 1) })}
                        >
                          <UI_ICONS.moveDown size={ICON_SIZE.sm} aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ))}

          {step === 3 && (
            <>
              <label className={s.group}>
                <span>Sheet name</span>
                <input
                  className={s.nameInput}
                  value={name}
                  maxLength={100}
                  onChange={(e) => set({ name: e.target.value, nameTouched: true })}
                />
              </label>
              <div className={s.group}>
                <span className={s.groupLabel}>Edits made in the sheet</span>
                <div role="radiogroup" aria-label="Edits made in the sheet" className={s.choices}>
                  <Choice on={d.edits === "keep"} onPick={() => set({ edits: "keep" })} title="Keep them">
                    LUME never changes a cell someone edited, and never adds back a row someone deleted.
                  </Choice>
                  <Choice
                    on={d.edits === "replace"}
                    onPick={() => set({ edits: "replace" })}
                    title="Put LUME's back"
                  >
                    Every update makes LUME&apos;s rows and columns match LUME again.
                  </Choice>
                </div>
                <p className={s.slow}>
                  Either way, columns and tabs you add are yours: LUME never touches them. A lead deleted from
                  LUME always leaves the sheet.
                </p>
              </div>
              {!editing && (
                <div className={s.group}>
                  <span className={s.groupLabel}>Google account</span>
                  {grants === null ? (
                    <p className={s.slow}>Looking for your Google accounts…</p>
                  ) : grants.length ? (
                    <div className={s.account}>
                      <select
                        className={s.nameInput}
                        aria-label="Google account"
                        value={grantId}
                        onChange={(e) => setGrantId(e.target.value)}
                      >
                        {grants.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.email}
                          </option>
                        ))}
                      </select>
                      <Button size="sm" variant="ghost" onClick={() => void connect()} disabled={busy}>
                        Use another account
                      </Button>
                    </div>
                  ) : (
                    <div className={s.account}>
                      <Button variant="secondary" onClick={() => void connect()} loading={busy}>
                        Connect Google
                      </Button>
                      <span className={s.slow}>
                        LUME can open only the sheets it makes, never your other files.
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </motion.div>

        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}
        <div className={s.foot}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <span className={s.grow} />
          {step < STEPS - 1 ? (
            <Button variant="primary" disabled={!canNext} onClick={() => go(step + 1)}>
              Next
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={!name.trim() || (!editing && !grantId) || !d.stageIds.length}
              onClick={() => void save()}
            >
              {editing ? "Save changes" : "Make the live sheet"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

const swap = (xs: string[], a: number, b: number) => {
  const out = [...xs];
  [out[a], out[b]] = [out[b]!, out[a]!];
  return out;
};

function Choice({
  on,
  onPick,
  title,
  badge,
  children,
}: {
  on: boolean;
  onPick(): void;
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={on} className={s.choice} onClick={onPick}>
      <span className={s.radio} aria-hidden />
      <strong>
        {title}
        {badge && <span className={s.recommended}>{badge}</span>}
      </strong>
      <small>{children}</small>
    </button>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <div className={s.toggle}>
      <p>
        {label}
        <small>{hint}</small>
      </p>
      <Switch checked={checked} onChange={onChange} label={label} labelHidden />
    </div>
  );
}
