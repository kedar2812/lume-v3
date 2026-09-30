"use client";
import { currencyForCountry, CURRENCIES } from "@lume/core/shared";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ClientView } from "@/server/clients";
import { SOURCES, type Source } from "@/lib/analytics";
import { api } from "@/lib/client";
import { convertAmount, formatMoney, inr, monthlyInr, rateOf } from "@/lib/money";
import { countryName, INDIA_STATES } from "@/lib/places";
import { Flag } from "./bits";

type Plan = "subscription" | "trial" | "perpetual";
export const SOURCE_WORDS: Record<Source, string> = {
  referrals: "Referrals",
  demo: "Demo site",
  website: "Website",
  instagram: "Instagram",
  other: "Other",
};
const COUNTRIES = (() => {
  const codes: string[] = [];
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const cc = String.fromCharCode(a, b);
      if (countryName(cc) !== cc) codes.push(cc);
    }
  return codes.map((cc) => ({ cc, name: countryName(cc) })).sort((x, y) => x.name.localeCompare(y.name));
})();
const STATES = Object.entries(INDIA_STATES).sort((a, b) => a[1].localeCompare(b[1]));
const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€", SGD: "S$", AUD: "A$" };
export const symbolOf = (cur: string) => SYMBOLS[cur] ?? cur;
/** The typed price as a number ("3,999" → 3999), or 0. */
export const amountOf = (s: string) => {
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
/** "171% above your ₹3,999 list price." — how a monthly price sits against the list price. */
export function vsList(monthly: number, list: number): string {
  if (!(list > 0)) return "";
  const v = Math.round(((monthly - list) / list) * 100);
  if (Math.abs(v) < 1) return `Your list price, ${inr(list)} a month.`;
  return `${Math.abs(v)}% ${v < 0 ? "below" : "above"} your ${inr(list)} list price.`;
}

/**
 * New licence (canvas: the Clients sheet): who they are, the plan and price in their currency with the live
 * "≈ ₹… a month in your analytics" line, and how they found LUME. Creating it shows the key, once.
 */
export function NewLicence({
  rates,
  listPriceInr,
  onClose,
  onCreated,
}: {
  rates: Record<string, number>;
  listPriceInr: number;
  onClose: () => void;
  onCreated: (c: ClientView) => void;
}) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("IN");
  const [region, setRegion] = useState("MH");
  const [city, setCity] = useState("");
  const [plan, setPlan] = useState<Plan>("subscription");
  const [currency, setCurrency] = useState("INR");
  const [amount, setAmount] = useState(listPriceInr > 0 ? String(listPriceInr) : "3999");
  const [period, setPeriod] = useState<1 | 3 | 12>(1);
  const [source, setSource] = useState<Source>("referrals");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [made, setMade] = useState<{ client: ClientView; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const known = useMemo(
    () =>
      [...new Set(["INR", ...Object.keys(rates)])]
        .filter((c) => (CURRENCIES as readonly string[]).includes(c))
        .sort(),
    [rates],
  );
  const currencies = known.includes(currency) ? known : [...known, currency].sort();
  const amt = amountOf(amount);
  const periodMonths = plan === "perpetual" ? 0 : period;
  const monthly =
    plan === "subscription" && amt ? monthlyInr({ amount: amt, currency, periodMonths }, rates) : null;
  const once =
    plan === "perpetual" && amt && rateOf(rates, currency) !== null ? amt * rateOf(rates, currency)! : null;
  const cannot = !name.trim() || !amt || busy;

  const switchTo = (next: string) => {
    const converted = convertAmount(amt, currency, next, rates);
    setCurrency(next);
    if (converted !== null && amt) setAmount(String(converted));
  };
  const pickCountry = (cc: string) => {
    setCountry(cc);
    const home = currencyForCountry(cc);
    if (home && home !== currency && (home === "INR" || rates[home])) switchTo(home);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cannot) return;
    setBusy(true);
    setError("");
    const r = await api.post<{ client: ClientView; licenseKey: string }>("/api/clients", {
      name: name.trim(),
      country,
      region: country === "IN" ? region : null,
      city: city.trim() || null,
      source,
      plan: { type: plan, currency, amount: amt, periodMonths },
    });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setMade({ client: r.data.client, key: r.data.licenseKey });
    onCreated(r.data.client);
  };

  if (made)
    return (
      <>
        <div className="scrim" onClick={onClose} aria-hidden />
        <div className="sheet" role="dialog" aria-modal="true" aria-label="Licence created">
          <div className="top">
            Licence created
            <CloseButton onClose={onClose} />
          </div>
          <div className="mid">
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--ink2)" }}>
              {made.client.name}&apos;s installation needs this key and its instance ID. Paste them into its{" "}
              <code>.env</code> as <code>LUME_LICENSE_KEY</code> and <code>LUME_INSTANCE_ID</code>.
            </p>
            <div className="field">
              Licence key
              <div className="keybox reveal">
                <span className="mono" style={{ flexGrow: 1, wordBreak: "break-all" }}>
                  {made.key}
                </span>
                <button
                  type="button"
                  className="btn second small"
                  onClick={() => {
                    void navigator.clipboard?.writeText(made.key);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="field">
              Instance ID
              <div className="keybox">
                <span className="mono">{made.client.instanceId}</span>
              </div>
            </div>
            <p className="preview col" style={{ margin: 0 }}>
              <strong>Shown once.</strong>
              <span style={{ color: "var(--ink2)" }}>
                LUME keeps only a fingerprint of the key. Lost, it can be rotated from the client&apos;s page.
              </span>
            </p>
          </div>
          <div className="foot">
            <button type="button" className="btn second" onClick={onClose}>
              Done
            </button>
            <Link className="btn primary" href={`/clients/${made.client.id}`}>
              Open {made.client.name}
            </Link>
          </div>
        </div>
      </>
    );

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <form
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="New licence"
        onSubmit={(e) => void create(e)}
      >
        <div className="top">
          New licence
          <CloseButton onClose={onClose} />
        </div>
        <div className="mid">
          <label className="field">
            Business name
            <input
              ref={first}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Harbour Clinic"
              maxLength={120}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
            <label className="field">
              Country
              <span style={{ position: "relative", display: "block" }}>
                <Flag
                  country={country}
                  decorative
                  style={{ position: "absolute", left: 12, top: 12, pointerEvents: "none" }}
                />
                <select
                  className="input"
                  aria-label="Country"
                  value={country}
                  onChange={(e) => pickCountry(e.target.value)}
                  style={{ paddingLeft: 44 }}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.cc} value={c.cc}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            {country === "IN" ? (
              <label className="field">
                State
                <select
                  className="input"
                  aria-label="State"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                >
                  {STATES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                City
                <input
                  className="input"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Dubai"
                  maxLength={80}
                />
              </label>
            )}
          </div>
          <div className="field">
            Plan
            <div className="chips" role="radiogroup" aria-label="Plan">
              {(
                [
                  ["subscription", "Subscription"],
                  ["trial", "Trial"],
                  ["perpetual", "One-time"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className="chip"
                  role="radio"
                  aria-checked={plan === v}
                  onClick={() => setPlan(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            {plan === "trial"
              ? "Price after the 14-day trial"
              : plan === "perpetual"
                ? "One-time price"
                : "Price"}
            <div style={{ display: "grid", gridTemplateColumns: "112px minmax(0, 1fr)", gap: 8 }}>
              <select
                className="input"
                aria-label="Currency"
                value={currency}
                onChange={(e) => switchTo(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <span className="money-in">
                <span aria-hidden>{symbolOf(currency)}</span>
                <input
                  className="input num"
                  aria-label="Price"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
                  style={{ paddingLeft: 18 + symbolOf(currency).length * 8 }}
                />
              </span>
            </div>
            {plan !== "perpetual" && (
              <div className="chips" role="radiogroup" aria-label="Billed">
                {(
                  [
                    [1, "Monthly"],
                    [3, "Quarterly"],
                    [12, "Yearly"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className="chip"
                    role="radio"
                    aria-checked={period === v}
                    onClick={() => setPeriod(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {plan !== "trial" && amt > 0 && (
            <div className="preview">
              <span
                style={{
                  width: 34,
                  height: 34,
                  flexShrink: 0,
                  borderRadius: 10,
                  background: "var(--blue)",
                  display: "grid",
                  placeItems: "center",
                }}
                aria-hidden
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 13.5h12M3.5 10.5l3-3.5 2.5 2 4-5" />
                </svg>
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <strong className="num" style={{ fontWeight: 600, fontSize: 14 }}>
                  {plan === "perpetual"
                    ? once !== null
                      ? `≈ ${inr(once)}, counted once`
                      : `${formatMoney(amt, currency)}, counted once`
                    : monthly !== null
                      ? `≈ ${inr(monthly)} a month in your analytics`
                      : `No rate for ${currency} yet: left out of the rupee totals until there is one`}
                </strong>
                <span style={{ color: "var(--ink2)" }}>
                  {plan === "perpetual"
                    ? "A one-time price isn't monthly revenue."
                    : monthly !== null
                      ? vsList(monthly, listPriceInr)
                      : ""}
                </span>
              </span>
            </div>
          )}
          <label className="field">
            How they found LUME
            <select
              className="input"
              aria-label="How they found LUME"
              value={source}
              onChange={(e) => setSource(e.target.value as Source)}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_WORDS[s]}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" style={{ margin: 0, color: "var(--redInk)", fontSize: 13 }}>
              {error}
            </p>
          )}
        </div>
        <div className="foot">
          <button type="button" className="btn second" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={cannot}>
            {busy ? "Creating…" : "Create licence"}
          </button>
        </div>
      </form>
    </>
  );
}

export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="bellbtn"
      aria-label="Close"
      onClick={onClose}
      style={{ width: 32, height: 32 }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        aria-hidden
      >
        <path d="M3 3l6 6M9 3l-6 6" />
      </svg>
    </button>
  );
}
