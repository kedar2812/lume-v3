"use client";
import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { leadsClient } from "@/lib/leads/client";
import { fieldErrors } from "@/lib/leads/errors";
import type { FieldDefView, Lead, Stage } from "@/lib/leads/types";
import { useCatalog } from "./CatalogProvider";
import { FieldEditor } from "./fields/FieldEditor";
import { LostReasonPicker } from "./LostReasonPicker";
import { patchFor, valueOf } from "./useLeadEditor";
import s from "./move.module.css";

type Pending = {
  lead: Lead;
  stage: Stage;
  mode: "lost" | "required";
  missing: FieldDefView[];
  resolve: (lead: Lead | null) => void;
};
type Attempt = { moved: Lead } | { missing: FieldDefView[] } | { refused: true };
const firstName = (lead: Lead) => (lead.name ?? "this lead").split(" ")[0];

/**
 * Every stage move in the app goes through here (drawer, board, table), so the rules are asked the same
 * way everywhere: a lost stage needs a reason, a stage with required fields asks for them, and a refusal
 * is explained. `request` resolves the moved lead, or null if nothing changed, so a board can put the
 * card back.
 */
export function useStageMove() {
  const catalog = useCatalog();
  const { toast } = useToast();
  const [pending, setPending] = useState<Pending | null>(null);

  const attempt = useCallback(
    async (
      lead: Lead,
      stage: Stage,
      extra: { lostReasonId?: string; lostNote?: string } = {},
    ): Promise<Attempt> => {
      const r = await leadsClient.move(lead.id, stage.id, extra);
      if (r.ok) return { moved: r.data.lead };
      if (r.code === "REQUIRED_FIELDS") {
        const keys = (r.details as { fields?: string[] } | undefined)?.fields ?? [];
        const missing = catalog.fields.filter((f) => keys.includes(f.key));
        if (missing.length) return { missing };
      }
      toast({ tone: "danger", title: `Couldn’t move ${lead.name ?? "this lead"}`, detail: r.message });
      return { refused: true };
    },
    [catalog.fields, toast],
  );

  const request = useCallback(
    (lead: Lead, stage: Stage) =>
      new Promise<Lead | null>((resolve) => {
        if (stage.kind === "lost") return setPending({ lead, stage, mode: "lost", missing: [], resolve });
        void attempt(lead, stage).then((res) => {
          if ("moved" in res) return resolve(res.moved);
          if ("missing" in res)
            return setPending({ lead, stage, mode: "required", missing: res.missing, resolve });
          resolve(null);
        });
      }),
    [attempt],
  );

  const finish = (lead: Lead | null) => {
    pending?.resolve(lead);
    setPending(null);
  };

  return {
    request,
    ui: pending ? (
      <MoveDialog
        key={pending.lead.id + pending.stage.id}
        pending={pending}
        attempt={attempt}
        onDone={finish}
      />
    ) : null,
  };
}

function MoveDialog({
  pending,
  attempt,
  onDone,
}: {
  pending: Pending;
  attempt: (
    lead: Lead,
    stage: Stage,
    extra?: { lostReasonId?: string; lostNote?: string },
  ) => Promise<Attempt>;
  onDone: (lead: Lead | null) => void;
}) {
  const catalog = useCatalog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(pending.missing);
  const values = useRef<Record<string, unknown>>(
    Object.fromEntries(pending.missing.map((f) => [f.key, valueOf(pending.lead, f)])),
  );
  const lead = useRef(pending.lead);
  const cancel = () => onDone(null);

  const markLost = async (lostReasonId: string, lostNote: string) => {
    setBusy(true);
    const res = await attempt(lead.current, pending.stage, {
      lostReasonId,
      ...(lostNote ? { lostNote } : {}),
    });
    setBusy(false);
    if ("moved" in res) return onDone(res.moved);
    if ("missing" in res) {
      setMissing(res.missing);
      return setError("This stage needs a few details first.");
    }
    onDone(null);
  };

  const saveAndMove = async () => {
    setBusy(true);
    setError(null);
    const body = missing.reduce<Record<string, unknown>>((acc, def) => {
      const part = patchFor(def, values.current[def.key]);
      return part.custom
        ? { ...acc, custom: { ...(acc.custom as object), ...(part.custom as object) } }
        : { ...acc, ...part };
    }, {});
    const saved = await leadsClient.patch(lead.current.id, lead.current.version, body);
    if (!saved.ok) {
      setBusy(false);
      const byField = fieldErrors(saved, catalog);
      return setError(
        saved.status === 409
          ? "Someone else just changed this lead. Close this and try again."
          : (Object.values(byField)[0] ?? saved.message),
      );
    }
    lead.current = saved.data.lead;
    const res = await attempt(lead.current, pending.stage);
    setBusy(false);
    if ("moved" in res) return onDone(res.moved);
    if ("missing" in res) {
      setMissing(res.missing);
      return setError("A few details are still missing.");
    }
    onDone(null);
  };

  if (pending.mode === "lost")
    return (
      <Dialog label={`Why was ${firstName(pending.lead)} lost?`} onClose={cancel}>
        <p className={s.title}>Why was {firstName(pending.lead)} lost?</p>
        <p className={s.sub}>The reason shapes what LUME suggests later, like who to re-engage.</p>
        <LostReasonPicker
          confirmLabel="Mark as lost"
          busy={busy}
          error={error}
          onConfirm={markLost}
          onCancel={cancel}
        />
      </Dialog>
    );

  return (
    <Dialog label={`Before moving to ${pending.stage.name}`} onClose={cancel}>
      <p className={s.title}>Before moving to {pending.stage.name}</p>
      <p className={s.sub}>
        This stage needs {missing.length === 1 ? "one detail" : "a few details"} about{" "}
        {firstName(pending.lead)}.
      </p>
      <div className={s.stack}>
        {missing.map((def) => (
          <div key={def.key}>
            <p className={s.fieldLabel} aria-hidden>
              {def.label}
            </p>
            <FieldEditor
              def={def}
              value={values.current[def.key]}
              inForm
              onCommit={(v) => (values.current[def.key] = v)}
              onCancel={cancel}
            />
          </div>
        ))}
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.actions}>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void saveAndMove()}>
            Save and move
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
