"use client";
import { AI_LEAD_TIERS, PLAN_TIERS, tierName, type PlanTier } from "@lume/core/shared";
import { useState } from "react";
import { api } from "@/lib/client";

type Module = "googleSheets" | "webhooks" | "googleCalendar" | "calendly" | "ai" | "whatsapp";
export type Plan = {
  places: number | null;
  modules: Record<Module, boolean>;
  aiReadsHourly: number | null;
  aiReadsWeekly: number | null;
  /** Paid WhatsApp messages a month (W3b-2). */
  paidSendsMonthly: number | null;
  /** LUME AI calls a month (Autopilot spec 2026-10-19 §4), and the top-ups signed around this month. */
  aiCallsMonthly: number | null;
  aiTopUps: { month: string; calls: number }[];
  /** AI leads a month (2026-11-12): Base 0; null no limit. Absent from a server answer before them. */
  aiLeadsMonthly?: number | null;
  aiLeadTopUps?: { month: string; leads: number }[];
  /** The tier (Plans and pricing, November 2026): null, none; absent from a server answer before tiers. */
  tier?: PlanTier | null;
};
/**
 * `knowsAi`: their LUME accepts plan2, so it keeps LUME AI, WhatsApp and the AI limits (spec 2026-10-18 §2.2).
 * `knowsPaid`: it accepts plan3, so it keeps the monthly limit on paid WhatsApp messages (W3b-2).
 * `knowsMonthly`: it accepts plan4, so LUME AI a month replaces its weekly reads (Autopilot A1).
 * `knowsLeads`: it accepts plan5, so it counts AI leads (2026-11-12); an older one counts 7 actions for each.
 */
export type Usage = {
  people: number;
  modulesOn: string[];
  knows: boolean;
  knowsAi: boolean;
  knowsPaid: boolean;
  knowsMonthly: boolean;
  knowsLeads?: boolean;
  /** It accepts plan6, so it switches on only what its tier has (November 2026). */
  knowsTiers?: boolean;
};

const MODULES: { key: Module; name: string; mark: string | null }[] = [
  { key: "googleSheets", name: "Google Sheets", mark: "/brand/google-sheets.png" },
  { key: "webhooks", name: "Webhooks", mark: null },
  { key: "googleCalendar", name: "Google Calendar", mark: "/brand/google-calendar.png" },
  { key: "calendly", name: "Calendly", mark: "/brand/calendly.svg" },
  { key: "ai", name: "LUME AI", mark: null },
  { key: "whatsapp", name: "WhatsApp", mark: "/brand/whatsapp.svg" },
];
/** The hidden safety net (AI leads, 2026-11-12): never shown to the client, sized well above use. */
const SAFETY = [
  { key: "aiReadsHourly", label: "Most an hour", most: 100_000, placeholder: "No limit" },
  { key: "aiCallsMonthly", label: "Most a month", most: 10_000_000, placeholder: "Automatic" },
  {
    key: "aiReadsWeekly",
    label: "Most a week (LUME before monthly limits)",
    most: 1_000_000,
    placeholder: "No limit",
  },
] as const;
const LEADS_MOST = 10_000_000;
/** AI leads typed: empty is no limit; a whole number from 0 (Base) to the most; anything else is invalid. */
const leadsOf = (typed: string): number | null | "invalid" => {
  const t = typed.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n <= LEADS_MOST ? n : "invalid";
};
const n = (x: number) => x.toLocaleString("en-IN");
const PAID_MOST = 10_000_000;
/** What's typed in an AI limit: empty is no limit; a whole number from 1 to its most; anything else is invalid. */
const limitOf = (typed: string, most: number): number | null | "invalid" => {
  const t = typed.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= 1 && n <= most ? n : "invalid";
};
const DEFAULT_PLACES = 5;

/**
 * Plan limits (spec 2026-10-17 control §3.3): how many places a client's LUME has, and which modules are in its
 * plan. Kept by their LUME from its next check-in; nothing there is ever removed.
 */
export function PlanLimits({
  clientId,
  clientName,
  version,
  plan,
  usage,
  onSaved,
}: {
  clientId: string;
  clientName: string;
  version: string | null;
  plan: Plan;
  usage: Usage;
  onSaved: (data: unknown) => void;
}) {
  const [unlimited, setUnlimited] = useState(plan.places === null);
  const [places, setPlaces] = useState(plan.places ?? Math.max(DEFAULT_PLACES, usage.people + 1));
  const [modules, setModules] = useState(plan.modules);
  const [typed, setTyped] = useState({
    aiReadsHourly: plan.aiReadsHourly === null ? "" : String(plan.aiReadsHourly),
    aiReadsWeekly: plan.aiReadsWeekly === null ? "" : String(plan.aiReadsWeekly),
    paidSendsMonthly: plan.paidSendsMonthly === null ? "" : String(plan.paidSendsMonthly),
    aiCallsMonthly: plan.aiCallsMonthly === null ? "" : String(plan.aiCallsMonthly),
    aiLeadsMonthly:
      plan.aiLeadsMonthly === null || plan.aiLeadsMonthly === undefined ? "" : String(plan.aiLeadsMonthly),
  });
  // Custom is chosen to type a number no tier has; a tier's own number shows as that tier.
  const [custom, setCustom] = useState(
    plan.aiLeadsMonthly !== null &&
      plan.aiLeadsMonthly !== undefined &&
      !AI_LEAD_TIERS.some((t) => t.leads === plan.aiLeadsMonthly),
  );
  const [tierNow, setTierNow] = useState<PlanTier | null>(plan.tier ?? null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const hourly = limitOf(typed.aiReadsHourly, 100_000);
  const weekly = limitOf(typed.aiReadsWeekly, 1_000_000);
  const paid = limitOf(typed.paidSendsMonthly, PAID_MOST);
  const monthly = limitOf(typed.aiCallsMonthly, PAID_MOST);
  const leads = leadsOf(typed.aiLeadsMonthly);
  const invalid =
    hourly === "invalid" ||
    weekly === "invalid" ||
    paid === "invalid" ||
    monthly === "invalid" ||
    leads === "invalid";
  const now = {
    places: unlimited ? null : places,
    modules,
    aiReadsHourly: hourly === "invalid" ? null : hourly,
    aiReadsWeekly: weekly === "invalid" ? null : weekly,
    paidSendsMonthly: paid === "invalid" ? null : paid,
    aiCallsMonthly: monthly === "invalid" ? null : monthly,
    aiLeadsMonthly: leads === "invalid" ? null : leads,
    tier: tierNow,
  };
  const dirty =
    now.places !== plan.places ||
    MODULES.some((m) => modules[m.key] !== plan.modules[m.key]) ||
    now.aiReadsHourly !== plan.aiReadsHourly ||
    now.aiReadsWeekly !== plan.aiReadsWeekly ||
    now.paidSendsMonthly !== plan.paidSendsMonthly ||
    now.aiCallsMonthly !== plan.aiCallsMonthly ||
    now.aiLeadsMonthly !== (plan.aiLeadsMonthly ?? null) ||
    tierNow !== (plan.tier ?? null);
  const tier = custom ? null : (AI_LEAD_TIERS.find((t) => t.leads === now.aiLeadsMonthly) ?? null);
  const pick = (v: number | null, isCustom = false) =>
    change(() => {
      setCustom(isCustom);
      setTyped((x) => ({ ...x, aiLeadsMonthly: v === null ? "" : String(v) }));
    });
  const change = (f: () => void) => {
    f();
    setSaved(false);
  };
  const free = places - usage.people;
  const peopleLine = unlimited
    ? `${usage.people} ${usage.people === 1 ? "person uses" : "people use"} it now.`
    : free < 0
      ? `${usage.people} people use it now: nobody loses access, but no one new can be added until there’s room.`
      : `${usage.people} ${usage.people === 1 ? "person uses" : "people use"} it now: ${free} ${free === 1 ? "place" : "places"} free.`;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await api.patch(`/api/clients/${clientId}/plan`, now);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setSaved(true);
    onSaved(r.data);
  };

  return (
    <section className="card" aria-label="Plan limits" style={{ animationDelay: ".04s" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <h2 className="h">Plan limits</h2>
        <span className="note">Kept by their LUME</span>
      </div>
      {!usage.knows && (
        <p className="note" style={{ margin: 0, fontSize: 13, color: "var(--ink2)" }}>
          Their LUME{version ? ` (${version})` : ""} can’t keep a plan yet; it will once it’s updated. What
          you set here waits for it.
        </p>
      )}
      <div className="pl-group">
        <span className="pl-label">Tier</span>
        <div className="chips" role="radiogroup" aria-label="Tier">
          {PLAN_TIERS.map((t) => (
            <button
              key={t}
              type="button"
              className="chip"
              role="radio"
              aria-checked={tierNow === t}
              onClick={() =>
                change(() => {
                  setTierNow(t);
                  // A tier brings its own AI leads; Custom keeps the number typed.
                  const leadsOfTier = AI_LEAD_TIERS.find((x) => x.key === t)?.leads;
                  if (!custom && leadsOfTier !== undefined)
                    setTyped((x) => ({ ...x, aiLeadsMonthly: String(leadsOfTier) }));
                })
              }
            >
              {tierName(t)}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            role="radio"
            aria-checked={tierNow === null}
            aria-label="No tier"
            onClick={() => change(() => setTierNow(null))}
          >
            None
          </button>
        </div>
        <span className="note">
          {usage.knows && !usage.knowsTiers
            ? `Their LUME${version ? ` (${version})` : ""} can’t keep a tier yet; it will once it’s updated. Until then Base switches LUME AI off, and the rest of LUME AI stays as it is.`
            : tierNow === null
              ? "No tier: nothing is locked. Every LUME AI feature works, within the limits below."
              : tierNow === "base"
                ? "Base is LUME without AI: their LUME switches LUME AI off and asks about Pro."
                : tierNow === "pro"
                  ? "Pro: Autopilot first messages and follow-ups, next steps and catch-ups. When a lead writes back, it’s their team’s to answer."
                  : "Every LUME AI feature, Autopilot replies and Ask me included."}
        </span>
      </div>
      <div className="pl-group">
        <span className="pl-label">Places</span>
        <div className="pl-row">
          <div className="chips" role="radiogroup" aria-label="Places">
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={unlimited}
              onClick={() => change(() => setUnlimited(true))}
            >
              No limit
            </button>
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={!unlimited}
              onClick={() => change(() => setUnlimited(false))}
            >
              A number
            </button>
          </div>
          {!unlimited && (
            <div className="pl-step" role="group" aria-label="How many places">
              <button
                type="button"
                aria-label="One fewer"
                disabled={places <= 1}
                onClick={() => change(() => setPlaces((n) => Math.max(1, n - 1)))}
              >
                −
              </button>
              <span className="num" aria-live="polite">
                {places}
              </span>
              <button
                type="button"
                aria-label="One more"
                disabled={places >= 10_000}
                onClick={() => change(() => setPlaces((n) => Math.min(10_000, n + 1)))}
              >
                +
              </button>
            </div>
          )}
        </div>
        <span className={`note${!unlimited && free < 0 ? " pl-warn" : ""}`}>{peopleLine}</span>
      </div>
      <div className="pl-group">
        <span className="pl-label">Modules</span>
        {MODULES.map((m) => {
          const on = modules[m.key];
          const onNow = usage.modulesOn.includes(m.key);
          const warn = !on && onNow;
          return (
            <div key={m.key} className="pl-mod">
              <span className="pl-mark" aria-hidden>
                {m.mark ? (
                  <img src={m.mark} alt="" width={20} height={20} />
                ) : m.key === "ai" ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9z" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                  </svg>
                )}
              </span>
              <span className="pl-mod-words">
                <b>{m.name}</b>
                <span className={warn ? "pl-warn" : "note"}>
                  {warn
                    ? `On at ${clientName} now. Switching it off stops it at their next check-in.`
                    : on
                      ? onNow
                        ? "In their plan · on now"
                        : "In their plan"
                      : "Not in their plan"}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${m.name} in their plan`}
                className="pl-switch"
                onClick={() => change(() => setModules((x) => ({ ...x, [m.key]: !x[m.key] })))}
              >
                <span className="pl-track" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="pl-group">
        <span className="pl-label">LUME AI</span>
        {usage.knows && !usage.knowsAi && (
          <span className="note">
            Their LUME{version ? ` (${version})` : ""} can’t keep LUME AI and WhatsApp settings yet; it will
            once it’s updated.
          </span>
        )}
        <span className="pl-sub">AI leads a month</span>
        <div className="chips" role="radiogroup" aria-label="AI leads a month">
          {AI_LEAD_TIERS.map((t) => (
            <button
              key={t.key}
              type="button"
              className="chip"
              role="radio"
              aria-checked={tier?.key === t.key}
              aria-label={`${t.name}: ${n(t.leads)} AI leads`}
              onClick={() => pick(t.leads)}
            >
              {t.name} · {n(t.leads)}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            role="radio"
            aria-checked={!custom && now.aiLeadsMonthly === null}
            aria-label="No AI leads limit"
            onClick={() => pick(null)}
          >
            No limit
          </button>
          <button
            type="button"
            className="chip"
            role="radio"
            aria-checked={custom}
            onClick={() => pick(now.aiLeadsMonthly, true)}
          >
            Custom
          </button>
        </div>
        {custom && (
          <div className="pl-row">
            <label className="field pl-limit">
              <span>AI leads a month</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                max={LEADS_MOST}
                step={1}
                placeholder="No limit"
                value={typed.aiLeadsMonthly}
                aria-invalid={leads === "invalid" || undefined}
                aria-describedby={leads === "invalid" ? "aiLeadsMonthly-problem" : undefined}
                onChange={(e) => change(() => setTyped((x) => ({ ...x, aiLeadsMonthly: e.target.value })))}
              />
              {leads === "invalid" && (
                <span id="aiLeadsMonthly-problem" className="pl-warn">
                  A whole number from 0, or empty for no limit.
                </span>
              )}
            </label>
          </div>
        )}
        <span className="note">
          {usage.knows && !usage.knowsLeads
            ? `Their LUME${version ? ` (${version})` : ""} counts LUME AI by its actions until it’s updated: 7 for each AI lead, unless you set the month below.`
            : "Leads LUME AI may start on in a month, on their clock from the 1st. Each counts once a month, and up to 20 replies and suggestions each. When they’re used up, leads it’s already working on carry on."}
        </span>
        {now.aiLeadsMonthly === 0 && tierNow !== "base" && (
          <span className="note">
            Base: LUME AI starts on no lead. Choosing a template and reading replies still work while LUME AI
            is on; switch LUME AI off above to stop it all.
          </span>
        )}
        <span className="pl-sub">Safety net (they never see it)</span>
        <div className="pl-row">
          {SAFETY.map((l) => {
            const bad = limitOf(typed[l.key], l.most) === "invalid";
            return (
              <label key={l.key} className="field pl-limit">
                <span>{l.label}</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={l.most}
                  step={1}
                  placeholder={l.placeholder}
                  value={typed[l.key]}
                  aria-invalid={bad || undefined}
                  aria-describedby={bad ? `${l.key}-problem` : undefined}
                  onChange={(e) => change(() => setTyped((x) => ({ ...x, [l.key]: e.target.value })))}
                />
                {bad && (
                  <span id={`${l.key}-problem`} className="pl-warn">
                    A whole number from 1, or empty for{" "}
                    {l.placeholder === "Automatic" ? "automatic" : "no limit"}.
                  </span>
                )}
              </label>
            );
          })}
        </div>
        <span className="note">
          How many times LUME AI may run, well above what they use. An empty month is automatic: 30 for each
          AI lead, at least 1,000.
        </span>
      </div>
      <div className="pl-group">
        <span className="pl-label">WhatsApp limit</span>
        {usage.knows && !usage.knowsPaid && (
          <span className="note">
            Their LUME{version ? ` (${version})` : ""} can’t keep this limit yet; it will once it’s updated.
          </span>
        )}
        <div className="pl-row">
          <label className="field pl-limit">
            <span>Paid WhatsApp messages a month</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={PAID_MOST}
              step={1}
              placeholder="No limit"
              value={typed.paidSendsMonthly}
              aria-invalid={paid === "invalid" || undefined}
              aria-describedby={paid === "invalid" ? "paidSendsMonthly-problem" : undefined}
              onChange={(e) => change(() => setTyped((x) => ({ ...x, paidSendsMonthly: e.target.value })))}
            />
            {paid === "invalid" && (
              <span id="paidSendsMonthly-problem" className="pl-warn">
                A whole number from 1, or empty for no limit.
              </span>
            )}
          </label>
        </div>
        <span className="note">
          Templates WhatsApp charges the client for, on their clock. At the limit their LUME sends no more
          until next month.
        </span>
      </div>
      {problem && (
        <p role="alert" className="fl-prob fl-red">
          {problem}
        </p>
      )}
      <div className="pl-row">
        <button
          type="button"
          className="btn primary"
          disabled={!dirty || busy || invalid}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="pl-saved" role="status">
            Saved. Their LUME keeps it from its next check-in, within 6 hours.
          </span>
        )}
      </div>
    </section>
  );
}
