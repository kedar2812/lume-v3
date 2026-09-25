"use client";
import { useState } from "react";
import { currencyCountry } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { CurrencyPicker } from "@/components/ui/CurrencyPicker";
import { Dialog } from "@/components/ui/Dialog";
import { currencyName } from "@/components/ui/currencies";
import { Flag } from "@/components/ui/SearchList";
import { settingsClient, type CurrencyQuote } from "@/lib/settings/client";
import s from "./settings.module.css";

type Step =
  | { kind: "idle" }
  | { kind: "picking" }
  | {
      kind: "confirm";
      to: string;
      quote: CurrencyQuote | null;
      loading: boolean;
      rate: string;
      busy: boolean;
      problem: string | null;
    };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const tidy = (rate: number) => String(Number(rate.toPrecision(6)));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "25 Sep 2026", spelled the same on every runtime (ICU's en-GB says "Sept"). */
const asOf = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** A rate the admin typed, or null when it can't be used: it must be a positive, finite number. */
export function parseRate(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 1e6 ? n : null;
}

function whatChanges(a: CurrencyQuote["affected"]) {
  const parts = [
    a.leads && plural(a.leads, "lead value", "lead values"),
    a.products && plural(a.products, "package price", "package prices"),
    a.customFields && plural(a.customFields, "money field", "money fields"),
  ].filter(Boolean) as string[];
  if (!parts.length) return "Nothing has an amount yet, so nothing needs converting.";
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${list} will be converted`;
}

/**
 * The one currency every amount in LUME is in. Changing it is deliberate: pick the new one, see
 * today's rate and exactly what it will convert, adjust the rate if needed, then confirm. Amounts
 * are converted once, on the server, in one transaction.
 */
export function CurrencySwitch({
  current,
  onSwitched,
  onForbidden,
}: {
  current: string;
  onSwitched: (currency: string) => void;
  onForbidden: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [done, setDone] = useState<string | null>(null);
  const confirm = step.kind === "confirm" ? step : null;

  const pick = async (to: string) => {
    if (to === current) return setStep({ kind: "idle" });
    setStep({ kind: "confirm", to, quote: null, loading: true, rate: "", busy: false, problem: null });
    const r = await settingsClient.quoteCurrency(to);
    if (!r.ok && r.status === 403) return onForbidden();
    setStep((st) =>
      st.kind === "confirm" && st.to === to
        ? r.ok
          ? { ...st, loading: false, quote: r.data, rate: tidy(r.data.rate) }
          : { ...st, loading: false }
        : st,
    );
  };

  const convert = async () => {
    if (!confirm) return;
    const rate = parseRate(confirm.rate);
    if (rate === null) return;
    setStep({ ...confirm, busy: true, problem: null });
    const r = await settingsClient.switchCurrency({ from: current, to: confirm.to, rate });
    if (r.ok) {
      setStep({ kind: "idle" });
      const { leads, products } = r.data.converted;
      const moved = [
        leads && plural(leads, "lead value", "lead values"),
        products && plural(products, "package price", "package prices"),
      ].filter(Boolean);
      setDone(
        `Every amount is now in ${currencyName(r.data.currency)}.` +
          (moved.length ? ` ${moved.join(" and ")} converted.` : ""),
      );
      onSwitched(r.data.currency);
      return;
    }
    if (r.status === 403) return onForbidden();
    setStep({
      ...confirm,
      busy: false,
      problem:
        r.code === "CURRENCY_CHANGED"
          ? "The currency was just changed by someone else. Reload to see it — nothing was converted."
          : "The currency couldn’t be changed. Nothing was converted — try again.",
    });
  };

  const rateOk = confirm ? parseRate(confirm.rate) !== null : false;

  return (
    <section className={s.panel} aria-labelledby="currency-title">
      <div className={s.panelHead}>
        <h2 id="currency-title" className={s.panelTitle}>
          Currency
        </h2>
      </div>
      <div className={s.currencyRow}>
        <Flag iso={currencyCountry(current)} />
        <div className={s.currencyText}>
          <span className={s.currencyName}>{currencyName(current)}</span>
          <span className={s.muted}>Every amount in LUME is in this currency.</span>
        </div>
        <span className={s.code}>{current}</span>
        {step.kind === "idle" && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setDone(null);
              setStep({ kind: "picking" });
            }}
          >
            Change currency
          </Button>
        )}
      </div>
      {done && (
        <p role="status" className={s.switched}>
          {done}
        </p>
      )}
      {step.kind === "picking" && (
        <div className={s.pickRow}>
          <CurrencyPicker label="New currency" value={current} onChange={(to) => void pick(to)} />
          <Button size="sm" variant="ghost" onClick={() => setStep({ kind: "idle" })}>
            Cancel
          </Button>
        </div>
      )}
      {confirm && (
        <Dialog
          label={`Change the currency to ${currencyName(confirm.to)}?`}
          onClose={() => !confirm.busy && setStep({ kind: "idle" })}
        >
          <h2 className={s.dialogTitle}>Change the currency to {currencyName(confirm.to)}?</h2>
          {confirm.loading ? (
            <p className={s.dialogText}>Getting today’s rate…</p>
          ) : confirm.quote ? (
            <>
              <p className={s.rateLine}>
                1 {current} = {tidy(confirm.quote.rate)} {confirm.to}
              </p>
              <p className={s.dialogMeta}>
                {confirm.quote.source}, {asOf(confirm.quote.asOf)}
              </p>
              <p className={s.dialogText}>
                {whatChanges(confirm.quote.affected)}
                {Object.values(confirm.quote.affected).some(Boolean) && " at the rate below, once."}
              </p>
            </>
          ) : (
            <p className={s.dialogText}>
              The live rate isn’t available right now. Type today’s rate to go ahead — every amount is
              converted with it, once.
            </p>
          )}
          {!confirm.loading && (
            <div className={s.rateField}>
              <label htmlFor="currency-rate">
                1 {current} in {confirm.to}
              </label>
              <input
                id="currency-rate"
                inputMode="decimal"
                autoComplete="off"
                value={confirm.rate}
                aria-invalid={confirm.rate !== "" && !rateOk ? true : undefined}
                onChange={(e) => setStep({ ...confirm, rate: e.target.value })}
              />
            </div>
          )}
          {confirm.problem && (
            <p role="alert" className={s.dialogProblem}>
              {confirm.problem}
            </p>
          )}
          <div className={s.dialogActions}>
            <Button variant="ghost" onClick={() => setStep({ kind: "idle" })} disabled={confirm.busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void convert()}
              disabled={confirm.loading || confirm.busy || !rateOk}
            >
              Convert to {confirm.to}
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
