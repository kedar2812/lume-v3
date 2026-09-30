"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientView } from "@/server/clients";
import { api, CHANGED } from "@/lib/client";
import { ago, day, dayShort, perWords, when } from "@/lib/format";
import { convertAmount, formatMoney, inr, monthlyInr } from "@/lib/money";
import { countryName, INDIA_STATES } from "@/lib/places";
import { utcDay } from "@/lib/state";
import { Bell } from "./Bell";
import { Flag, StatePill, Toast, useToast } from "./bits";
import { paidOf } from "./ClientsScreen";
import { amountOf, SOURCE_WORDS, symbolOf, vsList } from "./NewLicence";
import { Head } from "./Shell";

type Detail = {
  client: ClientView;
  installation: {
    version: string;
    ip: string | null;
    activeUsers: number;
    leadCount: number;
    lastCheckInAt: string;
    serverTime: string | null;
  } | null;
  checkIns: { from: string; seen: boolean }[];
  history: { at: string; kind: string; detail: Record<string, unknown> }[];
  payments: {
    id: string;
    amount: number;
    currency: string;
    amountInr: number | null;
    paidAt: string;
    paidUntil: string | null;
    note: string | null;
  }[];
  notice: { id: string; note: string; dueDate: string | null; createdAt: string } | null;
  rates: { day: string | null; ageDays: number | null; rates: Record<string, number> };
  listPriceInr: number;
};

/** "31% below your ₹3,999 list price", or "your list price" (the canvas's priceNote). */
function vsShort(monthly: number, list: number): string {
  if (!(list > 0)) return "";
  const v = Math.round(((monthly - list) / list) * 100);
  return Math.abs(v) < 1
    ? "your list price"
    : `${Math.abs(v)}% ${v < 0 ? "below" : "above"} your ${inr(list)} list price`;
}

const STATE_WORD: Record<string, string> = {
  active: "active",
  grace: "grace",
  read_only: "read-only",
  suspended: "suspended",
};
/** A history entry in words, with its dot's colour. */
function said(e: Detail["history"][number]): { text: string; color: string } {
  const d = e.detail;
  const money = (p: unknown) => {
    const x = p as { currency: string; amount: number; periodMonths: number } | null;
    return x
      ? `${formatMoney(x.amount, x.currency)}${x.periodMonths ? ` ${perWords(x.periodMonths)}` : " once"}`
      : "";
  };
  switch (e.kind) {
    case "created":
      return { text: "Licence created", color: "#9297a0" };
    case "first_check_in":
      return { text: `First check-in, on ${String(d.version)}`, color: "#2a5bff" };
    case "version":
      return { text: `Updated to ${String(d.to)}`, color: "#2a5bff" };
    case "state":
      return {
        text: `Moved to ${STATE_WORD[String(d.to)] ?? String(d.to)}`,
        color: d.to === "active" ? "#18a566" : d.to === "grace" ? "#f2a20c" : "#e5484d",
      };
    case "paid":
      return {
        text: d.until
          ? `Paid until ${day(String(d.until))}`
          : `Paid ${formatMoney(Number(d.amount), String(d.currency))}`,
        color: "#18a566",
      };
    case "extended":
      return { text: `Extended to ${day(String(d.until))}`, color: "#18a566" };
    case "converted":
      return { text: "Trial became a subscription", color: "#18a566" };
    case "price":
      return { text: `Price changed to ${money(d.to)}`, color: "#8b5cf6" };
    case "reminder_on":
      return { text: "Payment reminder sent", color: "#2a5bff" };
    case "reminder_off":
      return { text: "Payment reminder stopped", color: "#9297a0" };
    case "key_rotated":
      return { text: "Licence key rotated", color: "#9297a0" };
    case "suspended":
      return { text: "Suspended", color: "#e5484d" };
    case "resumed":
      return { text: "Resumed", color: "#18a566" };
    default:
      return { text: e.kind, color: "#9297a0" };
  }
}

/** One client (canvas: AdminClient): its check-ins, installation, history, price, payments, key, and Pause. */
export function ClientScreen({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [extending, setExtending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState<{
    currency: string;
    amount: string;
    periodMonths: number;
    from: string;
  } | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [typed, setTyped] = useState(0);
  const [copied, setCopied] = useState(false);
  const [morph, setMorph] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, say] = useToast();
  const typing = useRef<ReturnType<typeof setInterval>>(undefined);

  const load = useCallback(async () => {
    const r = await api.get<Detail>(`/api/clients/${id}`);
    if (r.ok) setD(r.data);
    else if (r.status === 404) setMissing(true);
  }, [id]);
  useEffect(() => {
    void load();
    const again = () => void load();
    window.addEventListener(CHANGED, again);
    return () => {
      window.removeEventListener(CHANGED, again);
      clearInterval(typing.current);
    };
  }, [load]);

  if (missing)
    return (
      <Head
        title="No such client"
        back={
          <Link className="back" href="/clients">
            ← Clients
          </Link>
        }
        sub="It may have been removed."
      />
    );
  if (!d)
    return (
      <Head
        title=""
        back={
          <Link className="back" href="/clients">
            ← Clients
          </Link>
        }
      />
    );

  const c = d.client;
  const rates = d.rates.rates;
  const today = utcDay(new Date());
  const paid = paidOf(c, today);
  const region = c.region ? (INDIA_STATES[c.region] ?? c.region) : null;
  const place = [c.city, region, countryName(c.country)].filter(Boolean).join(", ");

  /** Every action: one call, the page from its answer, a line to say what happened. */
  const act = async (
    path: string,
    body: unknown,
    words: (next: Detail) => string,
    method: "post" | "del" = "post",
  ) => {
    if (busy) return null;
    setBusy(true);
    const r =
      method === "del"
        ? await api.del<Detail>(path)
        : body === undefined
          ? await api.post<Detail>(path)
          : await api.post<Detail>(path, body);
    setBusy(false);
    if (!r.ok) {
      say(r.message);
      return null;
    }
    const next = { ...d, ...r.data };
    setD(next);
    if (next.client.state !== c.state) setMorph((m) => m + 1);
    say(words(next));
    return next;
  };

  const markPaid = () =>
    void act(`/api/clients/${id}/paid`, {}, (n) =>
      n.client.paidUntil
        ? `Paid until ${day(n.client.paidUntil)} · ${c.name} hears at its next check-in`
        : "Payment marked",
    );
  const extend = (months: 1 | 3 | 12) => {
    setExtending(false);
    void act(`/api/clients/${id}/extend`, { months }, (n) => {
      const until = n.client.type === "trial" ? n.client.trialEnds : n.client.paidUntil;
      return until
        ? `${n.client.type === "trial" ? "Trial runs until" : "Paid until"} ${day(until)} · ${c.name} hears at its next check-in`
        : "Extended";
    });
  };
  const rotate = async () => {
    const r = await act(
      `/api/clients/${id}/rotate`,
      undefined,
      () => "New key made · the old one stops at once",
    );
    const key = (r as (Detail & { licenseKey?: string }) | null)?.licenseKey;
    if (!key) return;
    setNewKey(key);
    setCopied(false);
    setTyped(0);
    clearInterval(typing.current);
    typing.current = setInterval(() => {
      setTyped((n) => {
        if (n + 1 >= key.length) clearInterval(typing.current);
        return n + 1;
      });
    }, 38);
  };

  const p = c.price;
  const draft = editing;
  const draftAmt = draft ? amountOf(draft.amount) : 0;
  const draftMonthly =
    draft && draftAmt && draft.periodMonths
      ? monthlyInr({ amount: draftAmt, currency: draft.currency, periodMonths: draft.periodMonths }, rates)
      : null;
  const bars = d.checkIns;
  const lastAt = d.installation?.lastCheckInAt ?? null;
  const silentH = lastAt ? Math.floor((Date.now() - Date.parse(lastAt)) / 3_600_000) : null;
  const typingNow = newKey !== null && typed < newKey.length;
  const canRemind = !d.notice && !composing && c.type !== "perpetual" && c.state !== "suspended";

  return (
    <>
      <Head
        back={
          <Link className="back" href="/clients">
            ← Clients
          </Link>
        }
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1>{c.name}</h1>
            <StatePill state={c.state} morph={morph} />
          </div>
        }
        sub={
          <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Flag country={c.country} style={{ width: 18, height: 13 }} />
            {place} · {c.slug} · since {day(c.createdAt.slice(0, 10))} · found LUME through{" "}
            {SOURCE_WORDS[c.source].toLowerCase()}
          </span>
        }
      >
        <Bell />
        {c.type !== "perpetual" && c.state !== "suspended" && (
          <button
            type="button"
            className="btn second"
            aria-expanded={extending}
            onClick={() => setExtending(!extending)}
          >
            Extend…
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          onClick={markPaid}
          disabled={busy || !p || c.state === "suspended"}
        >
          Mark paid
        </button>
      </Head>

      <div
        className="body"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.55fr) minmax(0, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <section className="card" aria-label="Check-ins">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <h2 className="h">Check-ins · last 14 days</h2>
              <span className="note">every 6 hours</span>
            </div>
            <div
              style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 70 }}
              role="img"
              aria-label={`${bars.filter((b) => b.seen).length} of ${bars.length} six-hour check-ins heard`}
            >
              {bars.map((b, i) => (
                <span
                  key={b.from}
                  className="vbar"
                  style={{
                    flex: 1,
                    maxWidth: 8,
                    borderRadius: 3,
                    height: b.seen ? 34 + ((i * 37) % 30) : 6,
                    background: b.seen
                      ? "var(--blue)"
                      : new Date(b.from) < new Date(c.createdAt)
                        ? "var(--line2)"
                        : "#f2a20c",
                    animationDelay: `${(i * 0.012).toFixed(3)}s`,
                  }}
                />
              ))}
            </div>
            <div
              style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--ink3)" }}
            >
              <span>{bars[0] ? dayShort(bars[0].from.slice(0, 10)) : ""}</span>
              {silentH !== null && silentH >= 24 && (
                <span style={{ color: "var(--amberInk)", fontWeight: 600 }}>
                  Nothing heard for {silentH} h
                </span>
              )}
              {!lastAt && <span style={{ fontWeight: 600 }}>Not installed yet</span>}
              <span>Now</span>
            </div>
          </section>

          <section className="card" aria-label="This installation" style={{ animationDelay: ".06s" }}>
            <h2 className="h">This installation</h2>
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "16px 20px",
                fontSize: 13.5,
              }}
            >
              {(
                [
                  ["Instance", c.instanceId],
                  ["Version", d.installation?.version ?? "—"],
                  ["Server", d.installation?.ip ?? "—"],
                  ["People using it", d.installation ? String(d.installation.activeUsers) : "—"],
                  [
                    "Leads (a count only)",
                    d.installation ? d.installation.leadCount.toLocaleString("en-IN") : "—",
                  ],
                  ["Last check-in", lastAt ? `${when(lastAt)} (${ago(lastAt)})` : "Not yet"],
                ] as const
              ).map(([k, v]) => (
                <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  <dt style={{ fontSize: 12, color: "var(--ink3)" }}>{k}</dt>
                  <dd className="num" style={{ margin: 0, fontWeight: 600, overflowWrap: "anywhere" }}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="card" aria-label="History" style={{ animationDelay: ".12s" }}>
            <h2 className="h">History</h2>
            <ol
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {d.history.map((e, i) => {
                const w = said(e);
                return (
                  <li
                    key={`${e.at}-${i}`}
                    style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13.5 }}
                  >
                    <span
                      style={{ width: 8, height: 8, borderRadius: "50%", background: w.color, flexShrink: 0 }}
                      aria-hidden
                    />
                    <span style={{ flexGrow: 1 }}>{w.text}</span>
                    <span style={{ color: "var(--ink3)", fontSize: 12.5 }}>
                      {dayShort(e.at.slice(0, 10))}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <section className="card" aria-label="Plan and price" style={{ animationDelay: ".02s" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: 24,
              }}
            >
              <h2 className="h">Plan and price</h2>
              {!draft && p && (
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    setEditing({
                      currency: p.currency,
                      amount: String(p.amount),
                      periodMonths: p.periodMonths,
                      from: "",
                    })
                  }
                >
                  Change
                </button>
              )}
            </div>
            {!draft && p && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, overflow: "hidden" }}>
                  <span
                    key={`${p.currency}${p.amount}`}
                    className="num roll"
                    style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.01em" }}
                  >
                    {formatMoney(p.amount, p.currency)}
                  </span>
                  <span style={{ fontSize: 13.5, color: "var(--ink2)" }}>
                    {p.periodMonths ? perWords(p.periodMonths) : "once"}
                  </span>
                </div>
                <span className="num" style={{ fontSize: 13, color: "var(--ink2)" }}>
                  {c.type === "trial"
                    ? `Trial until ${c.trialEnds ? day(c.trialEnds) : "—"}, then this price`
                    : !p.periodMonths
                      ? "One-time · a perpetual licence"
                      : [
                          `${{ 1: "Monthly", 3: "Quarterly", 12: "Yearly" }[p.periodMonths] ?? ""} subscription`,
                          p.currency !== "INR" || p.periodMonths !== 1
                            ? c.monthlyInr
                              ? `≈ ${inr(c.monthlyInr)} a month`
                              : "no rate yet"
                            : "",
                          c.monthlyInr ? vsShort(c.monthlyInr, d.listPriceInr) : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                </span>
              </div>
            )}
            {draft && (
              <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0, 1fr)", gap: 8 }}>
                  <select
                    className="input"
                    aria-label="Currency"
                    value={draft.currency}
                    onChange={(e) => {
                      const next = e.target.value;
                      const converted = convertAmount(draftAmt, draft.currency, next, rates);
                      setEditing({
                        ...draft,
                        currency: next,
                        amount: converted !== null && draftAmt ? String(converted) : draft.amount,
                        from: draftAmt && next !== p?.currency ? formatMoney(draftAmt, draft.currency) : "",
                      });
                    }}
                  >
                    {[...new Set(["INR", ...Object.keys(rates), draft.currency])].sort().map((cur) => (
                      <option key={cur} value={cur}>
                        {cur}
                      </option>
                    ))}
                  </select>
                  <span className="money-in">
                    <span aria-hidden>{symbolOf(draft.currency)}</span>
                    <input
                      className="input num"
                      aria-label="Price"
                      inputMode="decimal"
                      autoFocus
                      value={draft.amount}
                      onChange={(e) =>
                        setEditing({ ...draft, from: "", amount: e.target.value.replace(/[^\d.,]/g, "") })
                      }
                      style={{ paddingLeft: 18 + symbolOf(draft.currency).length * 8 }}
                    />
                  </span>
                </div>
                {draft.periodMonths > 0 && (
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
                        aria-checked={draft.periodMonths === v}
                        onClick={() => setEditing({ ...draft, periodMonths: v })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <div className="preview col">
                  <strong className="num" style={{ fontWeight: 600 }}>
                    {!draftAmt
                      ? "Type a price"
                      : draftMonthly !== null
                        ? `≈ ${inr(draftMonthly)} a month in your analytics`
                        : draft.periodMonths
                          ? `No rate for ${draft.currency} yet`
                          : "A one-time price"}
                  </strong>
                  {draftMonthly !== null && (
                    <span style={{ color: "var(--ink2)" }}>{vsList(draftMonthly, d.listPriceInr)}</span>
                  )}
                  {draft.from && (
                    <span className="num" style={{ color: "var(--ink3)", fontSize: 12, marginTop: 2 }}>
                      Converted from {draft.from} at today&apos;s rate. Round it however you like.
                    </span>
                  )}
                </div>
                <span className="note">
                  Starts with the next bill. Payments already marked keep their amount and rate.
                </span>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button type="button" className="btn second small" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    disabled={!draftAmt || busy}
                    onClick={async () => {
                      const r = await act(
                        `/api/clients/${id}/price`,
                        { currency: draft.currency, amount: draftAmt, periodMonths: draft.periodMonths },
                        () => "New price saved · it starts with the next bill",
                      );
                      if (r) setEditing(null);
                    }}
                  >
                    Save price
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="card" aria-label="Payment" style={{ animationDelay: ".08s" }}>
            <h2 className="h">Payment</h2>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.01em" }}>{paid.main}</span>
              {paid.note && (
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: paid.late ? "var(--redInk)" : "var(--greenInk)",
                  }}
                >
                  {paid.note}
                </span>
              )}
            </div>
            <span style={{ fontSize: 13, color: "var(--ink2)" }}>
              Marked by hand (UPI or bank). A payment gateway comes later.
            </span>
            {d.notice && (
              <div
                className="reveal"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "11px 13px",
                  borderRadius: 12,
                  background: "var(--tint)",
                  fontSize: 13,
                  color: "var(--accentInk)",
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 30 30"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M8 20V13a7 7 0 0114 0v7l2 2.5H6z" />
                  <path d="M12.5 25.5a2.7 2.7 0 005 0" />
                </svg>
                <span style={{ flexGrow: 1 }}>
                  <strong style={{ fontWeight: 600 }}>Reminder on.</strong> Their owner and admins see it at
                  every sign-in until it&apos;s paid.
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    void act(`/api/clients/${id}/reminder`, undefined, () => "Reminder stopped", "del")
                  }
                >
                  Stop
                </button>
              </div>
            )}
            {composing && (
              <div
                className="reveal"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  padding: 14,
                  borderRadius: 12,
                  background: "var(--sunk)",
                  boxShadow: "inset 0 0 0 .5px var(--line)",
                }}
              >
                <label className="field">
                  Your note (optional)
                  <textarea
                    className="input"
                    rows={3}
                    maxLength={1000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button type="button" className="btn second small" onClick={() => setComposing(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={async () => {
                      const r = await act(
                        `/api/clients/${id}/reminder`,
                        { note: note.trim() },
                        () => `Reminder sent · ${c.name} sees it at their next sign-in`,
                      );
                      if (r) setComposing(false);
                    }}
                  >
                    Send reminder
                  </button>
                </div>
              </div>
            )}
            {canRemind && (
              <div>
                <button
                  type="button"
                  className="btn second"
                  onClick={() => {
                    setNote(
                      "A gentle reminder about your LUME licence. UPI or bank transfer is fine, same details as before. Thank you!",
                    );
                    setComposing(true);
                  }}
                >
                  Send payment reminder
                </button>
              </div>
            )}
            {extending && (
              <div className="reveal chips">
                <button type="button" className="chip" onClick={() => extend(1)}>
                  +1 month
                </button>
                <button type="button" className="chip" onClick={() => extend(3)}>
                  +3 months
                </button>
                <button type="button" className="chip" onClick={() => extend(12)}>
                  +1 year
                </button>
              </div>
            )}
            {d.payments.length > 0 && (
              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  fontSize: 12.5,
                  color: "var(--ink2)",
                }}
              >
                {d.payments.slice(0, 3).map((x) => (
                  <li
                    key={x.id}
                    className="num"
                    style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
                  >
                    <span>
                      Paid {formatMoney(x.amount, x.currency)}
                      {x.currency !== "INR" &&
                        (x.amountInr !== null ? ` (${inr(x.amountInr)})` : " (rate unknown)")}
                    </span>
                    <span>{day(x.paidAt.slice(0, 10))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Licence key" style={{ animationDelay: ".1s" }}>
            <h2 className="h">Licence key</h2>
            <div className="keybox">
              <span className="mono" style={{ flexGrow: 1, overflowWrap: "anywhere" }}>
                {newKey === null ? c.keyMasked : newKey.slice(0, typed)}
                {typingNow && <span className="caret" aria-hidden />}
              </span>
              {newKey !== null && !typingNow && (
                <button
                  type="button"
                  className="btn second small"
                  style={{ height: 30, padding: "0 10px" }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(newKey);
                    setCopied(true);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
            </div>
            <span style={{ fontSize: 13, color: "var(--ink2)" }}>
              {newKey !== null && !typingNow
                ? "Shown once. Paste it into their .env as LUME_LICENSE_KEY; the old key has already stopped."
                : "Only the last four are ever shown again."}
            </span>
            <div>
              <button
                type="button"
                className="btn second"
                onClick={() => void rotate()}
                disabled={typingNow || busy}
              >
                Rotate key
              </button>
            </div>
          </section>

          <section
            className="card"
            aria-label="Pause this LUME"
            style={{ animationDelay: ".16s", boxShadow: "0 0 0 .5px rgba(229,72,77,.35)" }}
          >
            <h2 className="h" style={{ color: "var(--redInk)" }}>
              Pause this LUME
            </h2>
            <span style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink2)" }}>
              {c.state === "suspended"
                ? `${c.name} sees the pause screen. Their admin can still export all their data. Resume lets them carry on from the next check-in.`
                : `Everyone at ${c.name} sees a pause screen at the next check-in. Their admin can still export all their data.`}
            </span>
            {c.state === "suspended" ? (
              <div>
                <button
                  type="button"
                  className="btn second"
                  onClick={() =>
                    void act(
                      `/api/clients/${id}/resume`,
                      undefined,
                      () => `${c.name} is back on · from its next check-in`,
                    )
                  }
                >
                  Resume
                </button>
              </div>
            ) : confirming ? (
              <div
                className="reveal"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: 12,
                  borderRadius: 12,
                  background: "var(--redBg)",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ flexGrow: 1, fontSize: 13, fontWeight: 600, color: "var(--redInk)" }}>
                  Suspend {c.name}?
                </span>
                <button type="button" className="btn second small" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
                <button
                  type="button"
                  className="btn danger-solid small"
                  onClick={async () => {
                    setConfirming(false);
                    await act(
                      `/api/clients/${id}/suspend`,
                      undefined,
                      () => `${c.name} is suspended · they can still export everything`,
                    );
                  }}
                >
                  Suspend
                </button>
              </div>
            ) : (
              <div>
                <button type="button" className="btn danger" onClick={() => setConfirming(true)}>
                  Suspend…
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
      <Toast msg={toast} />
    </>
  );
}
