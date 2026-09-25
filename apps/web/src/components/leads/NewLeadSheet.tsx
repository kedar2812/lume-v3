"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { can, scopeOf } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/IconButton";
import { PhoneInput } from "@/components/ui/PhoneInput";
import { leadsClient } from "@/lib/leads/client";
import { tokenColor } from "@/lib/leads/colors";
import { fieldErrors } from "@/lib/leads/errors";
import type { Duplicate, FieldDefView, Lead } from "@/lib/leads/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { Session } from "@/server/session";
import { useCatalog } from "./CatalogProvider";
import { FieldEditor } from "./fields/FieldEditor";
import { useDuplicates } from "./useDuplicates";
import d from "./drawer/drawer.module.css";
import s from "./sheet.module.css";

const ME = "";
const NOBODY = "none";
const KIND_WORD = { phone: "phone", email: "email", instagram: "Instagram" } as const;
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
const empty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** One line per possible duplicate. A lead the person can't see is never named, nor is its owner. */
function duplicateLine(dup: Duplicate) {
  const what = KIND_WORD[dup.matchedOn[0] ?? "phone"];
  if (!dup.visible) return <>A lead with this {what} already exists</>;
  return (
    <>
      {dup.name} already has this {what}
      {dup.ownerName ? ` · handled by ${dup.ownerName}` : ""}{" "}
      <Link href={`/leads?lead=${dup.leadId}`} className={s.dupLink}>
        Open {dup.name}
      </Link>
    </>
  );
}

/**
 * Add a lead by hand: the essentials first, then anything else the business tracks. Possible duplicates
 * are pointed out while typing, as a warning only: people do share numbers.
 */
export function NewLeadSheet({
  session,
  onCreated,
  onClose,
}: {
  session: Session;
  onCreated: (lead: Lead) => void;
  onClose: () => void;
}) {
  const catalog = useCatalog();
  const reduce = useReducedMotion();
  const titleId = useId();
  const panel = useRef<HTMLFormElement>(null);
  const pipeline = catalog.pipelines.find((p) => p.isDefault) ?? catalog.pipelines[0];
  const openStages = pipeline?.stages.filter((st) => st.kind === "open") ?? [];
  const fieldByKey = (key: string) => catalog.fields.find((f) => f.key === key);
  const writable = (key: string) => {
    const f = fieldByKey(key);
    return !!f && !f.archived && f.access === "edit";
  };
  const productField = fieldByKey("product");
  // Packages come from settings; the field only gets a say when the registry has one.
  const showProduct =
    catalog.products.length > 0 &&
    (!productField || (!productField.archived && productField.access === "edit"));
  const customFields = catalog.fields.filter((f) => !f.isCore && !f.archived && f.access === "edit");
  const mayAssign = can(session.actor, "leads.assign");
  const mayLeaveUnassigned = scopeOf(session.actor, "leads.assign") === "all";
  const others = catalog.people.filter((p) => p.active && p.id !== session.user.id);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [instagram, setInstagram] = useState("");
  const [stageId, setStageId] = useState(openStages[0]?.id ?? "");
  const [owner, setOwner] = useState(ME);
  const [value, setValue] = useState("");
  const [valueTyped, setValueTyped] = useState(false);
  const [productId, setProductId] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const custom = useRef<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const duplicates = useDuplicates({ phone, email });

  // Focus starts on Name, and goes back where it was when the sheet closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (before?.isConnected) before.focus();
    };
  }, []);
  // Closing never throws away typing silently: with anything filled in, it asks first.
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clearError = (key: string) =>
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const pickProduct = (id: string) => {
    setProductId(id);
    const price = catalog.products.find((p) => p.id === id)?.defaultValue;
    if (!valueTyped && price !== null && price !== undefined) setValue(String(price));
  };

  // After the errors render, focus goes to the first field that needs attention.
  const [errorTick, setErrorTick] = useState(0);
  const focusFirstError = () => setErrorTick((n) => n + 1);
  useEffect(() => {
    if (errorTick) panel.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errorTick]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = "Give the lead a name";
    const rawValue = value.replace(/[\s,]/g, "");
    const amount = rawValue === "" ? null : Number(rawValue);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      problems.value = "Enter an amount of 0 or more";
    for (const f of customFields)
      if (f.isRequired && empty(custom.current[f.key])) problems[f.key] = `${f.label} is needed`;
    setErrors(problems);
    if (Object.keys(problems).length) return focusFirstError();

    const filledCustom = Object.fromEntries(Object.entries(custom.current).filter(([, v]) => !empty(v)));
    const body: Record<string, unknown> = {
      name: name.trim(),
      ...(pipeline ? { pipelineId: pipeline.id } : {}),
      ...(stageId ? { stageId } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(instagram.trim() ? { instagram: instagram.trim().replace(/^@/, "") } : {}),
      ...(mayAssign && owner !== ME ? { ownerId: owner === NOBODY ? null : owner } : {}),
      ...(amount !== null ? { value: amount } : {}),
      ...(productId ? { productId } : {}),
      ...(tagIds.length ? { tagIds } : {}),
      ...(Object.keys(filledCustom).length ? { custom: filledCustom } : {}),
    };
    setBusy(true);
    const r = await leadsClient.create(body);
    setBusy(false);
    if (r.ok) return onCreated(r.data.lead);
    const byField = fieldErrors(r, catalog);
    if (Object.keys(byField).length) {
      setErrors(byField);
      return focusFirstError();
    }
    setFormError(r.message);
  };

  const trap = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  const customEditor = (def: FieldDefView) => (
    <div key={def.id} className={s.custom}>
      <p className={s.caption} aria-hidden>
        {def.label}
        {def.isRequired && <span> · needed</span>}
      </p>
      <FieldEditor
        def={def}
        value={undefined}
        inForm
        error={errors[def.key] ?? null}
        onCommit={(v) => {
          custom.current[def.key] = v;
          clearError(def.key);
        }}
        onCancel={() => undefined}
      />
    </div>
  );

  return (
    <>
      <motion.div
        className={d.scrim}
        onClick={requestClose}
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />
      <motion.form
        ref={panel}
        method="post"
        noValidate
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={d.drawer}
        onSubmit={submit}
        onKeyDown={trap}
        onChange={() => {
          setDirty(true);
          setConfirmDiscard(false);
        }}
        // The resting state names both properties: the server can't know the motion preference, so a
        // drawer rendered there may start off-screen even for someone who then gets the fade.
        initial={reduce ? { opacity: 0, x: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
        animate={{ opacity: 1, x: 0 }}
        exit={reduce ? { opacity: 0, x: 0 } : { opacity: 1, x: "calc(100% + 24px)" }}
        transition={toMotion(SPRINGS.drawer)}
      >
        <div className={d.top}>
          <IconButton label="Close (Esc)" onClick={requestClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconButton>
          <h2 id={titleId} className={s.title}>
            New lead
          </h2>
        </div>

        <div className={d.scroll}>
          <Field label="Name" error={errors.name}>
            {(c) => (
              <input
                {...c}
                autoComplete="off"
                maxLength={200}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError("name");
                }}
              />
            )}
          </Field>

          <div className={s.pair}>
            {writable("phone") && (
              <Field label="Phone" error={errors.phone}>
                {(c) => (
                  <PhoneInput
                    {...c}
                    value={phone}
                    defaultCountry={catalog.country}
                    onChange={(v) => {
                      setPhone(v);
                      setDirty(true);
                      clearError("phone");
                    }}
                  />
                )}
              </Field>
            )}
            {writable("email") && (
              <Field label="Email" error={errors.email}>
                {(c) => (
                  <input
                    {...c}
                    type="email"
                    autoComplete="off"
                    maxLength={254}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      clearError("email");
                    }}
                  />
                )}
              </Field>
            )}
          </div>
          <p role="status" className={s.dups}>
            {duplicates.map((dup, i) => (
              <span key={dup.visible ? dup.leadId : `hidden-${i}`} className={s.dup}>
                {duplicateLine(dup)}
              </span>
            ))}
          </p>

          {writable("instagram") && (
            <Field label="Instagram" error={errors.instagram}>
              {(c) => (
                <input
                  {...c}
                  autoComplete="off"
                  placeholder="@handle"
                  maxLength={31}
                  value={instagram}
                  onChange={(e) => {
                    setInstagram(e.target.value);
                    clearError("instagram");
                  }}
                />
              )}
            </Field>
          )}

          <div className={s.pair}>
            {openStages.length > 1 && (
              <Field label="Stage">
                {(c) => (
                  <select {...c} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                    {openStages.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            {mayAssign && (
              <Field label="Owner" error={errors.ownerId}>
                {(c) => (
                  <select {...c} value={owner} onChange={(e) => setOwner(e.target.value)}>
                    <option value={ME}>{session.user.name} (you)</option>
                    {others.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    {mayLeaveUnassigned && <option value={NOBODY}>Unassigned</option>}
                  </select>
                )}
              </Field>
            )}
          </div>

          <div className={s.pair}>
            {writable("value") && (
              <Field label="Deal value" hint={catalog.currency} error={errors.value}>
                {(c) => (
                  <input
                    {...c}
                    inputMode="decimal"
                    autoComplete="off"
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                      setValueTyped(e.target.value !== "");
                      clearError("value");
                    }}
                  />
                )}
              </Field>
            )}
            {showProduct && (
              <Field label="Package" error={errors.product}>
                {(c) => (
                  <select {...c} value={productId} onChange={(e) => pickProduct(e.target.value)}>
                    <option value="">None</option>
                    {catalog.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
          </div>

          {catalog.tags.length > 0 && (
            <div className={s.tagGroup} role="group" aria-label="Tags">
              <p className={s.caption} aria-hidden>
                Tags
              </p>
              <div className={s.tags}>
                {catalog.tags.map((t) => {
                  const on = tagIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      className={s.tag}
                      style={{ ["--c" as string]: tokenColor(t.color) }}
                      onClick={() => {
                        setTagIds(on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id]);
                        setDirty(true);
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {customFields.length > 0 && <div className={s.customs}>{customFields.map(customEditor)}</div>}
        </div>

        {confirmDiscard ? (
          <div className={s.footer} role="alert">
            <p className={s.discardText}>Discard this lead?</p>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={onClose}>
              Discard
            </Button>
          </div>
        ) : (
          <div className={s.footer}>
            {formError && (
              <p role="alert" className={s.formError}>
                {formError}
              </p>
            )}
            <Button variant="ghost" onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Create lead
            </Button>
          </div>
        )}
      </motion.form>
    </>
  );
}
