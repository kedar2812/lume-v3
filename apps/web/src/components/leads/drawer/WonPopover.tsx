"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import type { Catalog, Lead } from "@/lib/leads/types";
import s from "./drawer.module.css";

export type WonChange = { value?: number | null; productId?: string | null };

/**
 * "Mark as won", with the deal value and package confirmed on the way (the prototype's won popover): the
 * numbers that end up in revenue are checked at the moment they matter.
 */
export function WonPopover({
  lead,
  catalog,
  onConfirm,
}: {
  lead: Lead;
  catalog: Catalog;
  /** Resolves once the lead is won (or the attempt was explained); the popover closes after it. */
  onConfirm: (change: WonChange) => Promise<void>;
}) {
  return (
    <Popover label={`Mark ${firstName(lead)} as won`} triggerClassName={s.wonBtn} align="end" trigger="Won">
      {(close) => <WonForm lead={lead} catalog={catalog} onConfirm={onConfirm} close={close} />}
    </Popover>
  );
}

const firstName = (lead: Lead) => (lead.name ?? "this lead").split(" ")[0];

/** Mounted each time the popover opens, so it always starts from the lead as it is now. */
function WonForm({
  lead,
  catalog,
  onConfirm,
  close,
}: {
  lead: Lead;
  catalog: Catalog;
  onConfirm: (change: WonChange) => Promise<void>;
  close: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(
    lead.value === null || lead.value === undefined ? "" : String(lead.value),
  );
  const [product, setProduct] = useState<string | null>(lead.productId ?? null);
  const [typed, setTyped] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickProduct = (pid: string) => {
    setProduct(pid);
    const price = catalog.products.find((x) => x.id === pid)?.defaultValue;
    // A package's price fills the value, unless the person already typed one.
    if (!typed && price !== null && price !== undefined) setValue(String(price));
  };

  return (
    <form
      method="post"
      className={s.popForm}
      onSubmit={async (e) => {
        e.preventDefault();
        const raw = value.replace(/[\s,]/g, "");
        const n = raw === "" ? null : Number(raw);
        if (n !== null && (!Number.isFinite(n) || n < 0)) return setProblem("Enter an amount of 0 or more");
        const change: WonChange = {};
        if (n !== (lead.value ?? null)) change.value = n;
        if (product !== (lead.productId ?? null)) change.productId = product;
        setBusy(true);
        await onConfirm(change);
        setBusy(false);
        close();
      }}
    >
      <p className={s.popTitle}>Mark {firstName(lead)} as won</p>
      <label htmlFor={id} className={s.popLabel}>
        Deal value
      </label>
      <div className={s.money}>
        <span aria-hidden>{lead.currency ?? catalog.currency}</span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setTyped(true);
            setProblem(null);
          }}
        />
      </div>
      {problem && (
        <p role="alert" className={s.popError}>
          {problem}
        </p>
      )}
      {catalog.products.length > 0 && (
        <fieldset className={s.chipSet}>
          <legend className={s.popLabel}>Package</legend>
          <div className={s.chips}>
            {catalog.products.map((p) => (
              <label key={p.id} className={s.chip} data-on={product === p.id || undefined}>
                <input
                  type="radio"
                  name={`${id}-product`}
                  checked={product === p.id}
                  onChange={() => pickProduct(p.id)}
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <Button type="submit" variant="primary" className={s.wonSubmit} loading={busy}>
        Mark as won
      </Button>
    </form>
  );
}
