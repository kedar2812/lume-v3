"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ICON_SIZE, TRIGGER_ICONS } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import {
  flowsClient,
  type FlowCounts,
  type FlowListItem,
  type FlowTrigger,
  type FlowsSummary,
} from "@/lib/flows/client";
import { money } from "@/lib/analytics/words";
import { FlowsBoard } from "./FlowsBoard";
import { NewFlowSheet } from "./NewFlowSheet";
import s from "./flows.module.css";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;
type Range = (typeof RANGES)[number]["value"];
type SortKey = "name" | "active" | "triggered" | "finished" | "leads" | "rate" | "won" | "revenue";
const HEADS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Flow" },
  { key: "active", label: "In it now" },
  { key: "triggered", label: "Started" },
  { key: "finished", label: "Finished" },
  { key: "leads", label: "Leads" },
  { key: "rate", label: "Lead rate" },
  { key: "won", label: "Won" },
  { key: "revenue", label: "Revenue" },
];
const DASH = "—";
const n = (v: number) => v.toLocaleString("en-IN");
/** A share in whole percent, or a dash when there's nothing to divide by (never NaN, never a made-up 0%). */
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part * 100) / whole)}%` : DASH);

const KIND: Record<FlowTrigger["kind"], string> = {
  comment: "Comment",
  dm: "DM",
  story_reply: "Any reply to a story",
  story_mention: "A story mention",
  ad: "An ad click",
  welcome: "First DM",
};
/** What starts a flow, in a few words: its first way in and first keyword ("Comment “GUIDE” +2"). */
function startsWith(f: FlowListItem): { kind: FlowTrigger["kind"] | null; words: string } {
  const on = f.triggers.filter((t) => t.enabled);
  const t = on[0] ?? f.triggers[0];
  if (!t) return { kind: null, words: "Nothing starts it yet" };
  const keyed = (t.kind === "comment" || t.kind === "dm") && t.keywords.length > 0 && t.mode !== "any";
  let words = keyed
    ? `${KIND[t.kind]} “${t.keywords[0]}”${t.keywords.length > 1 ? ` +${t.keywords.length - 1}` : ""}`
    : t.kind === "comment"
      ? "Any comment"
      : t.kind === "dm"
        ? "Any DM"
        : KIND[t.kind];
  if (on.length > 1) words += ` · ${on.length - 1} more way${on.length > 2 ? "s" : ""} in`;
  return { kind: t.kind, words };
}

/**
 * The Flows page (plan 2026-11-25-instagram-screens D3; canvas board Flows): what the flows did over the business's
 * last days, and every flow with what starts it, whether it's on, who is in it now and what it brought. The board's
 * chart, funnel, posts and notes come with Analytics (D6).
 */
export function FlowsList({ currency = null }: { currency?: string | null }) {
  const [flows, setFlows] = useState<FlowListItem[] | null>(null);
  const [off, setOff] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<Range>("30");
  const [sum, setSum] = useState<FlowsSummary | null>(null);
  const [sumFailed, setSumFailed] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const r = await flowsClient.list();
    if (r.ok) return setFlows(r.data.flows);
    if (r.status === 409) return setOff(r.message);
    setFailed(true);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    let live = true;
    setSumFailed(false);
    void flowsClient.summary(Number(range)).then((r) => {
      if (!live) return;
      if (r.ok) setSum(r.data);
      else {
        setSum(null);
        setSumFailed(true);
      }
    });
    return () => {
      live = false;
    };
  }, [range]);

  const countsOf = useMemo(() => new Map((sum?.flows ?? []).map((c) => [c.id, c])), [sum]);
  const rows = useMemo(() => {
    const list = (flows ?? []).map((f, i) => ({ f, c: countsOf.get(f.id) ?? null, i }));
    if (!sort) return list;
    const val = (x: (typeof list)[number]): number | string => {
      if (sort.key === "name") return x.f.name.toLocaleLowerCase();
      if (sort.key === "active") return x.f.active;
      if (!x.c) return -1;
      if (sort.key === "rate") return x.c.triggered ? x.c.leads / x.c.triggered : -1;
      if (sort.key === "finished") return x.c.triggered ? x.c.finished / x.c.triggered : -1;
      return x.c[sort.key] ?? -1;
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : a.i - b.i) * sort.dir;
    });
  }, [flows, countsOf, sort]);

  const [switching, setSwitching] = useState<string | null>(null);
  const toggle = async (f: FlowListItem, on: boolean) => {
    if (switching) return;
    setSwitching(f.id);
    setError(null);
    const r = await flowsClient.setStatus(f.id, f.rev, on ? "live" : "paused");
    if (!r.ok) {
      setSwitching(null);
      return setError(r.message);
    }
    await load();
    setSwitching(null);
  };

  const create = (
    <Button variant="primary" onClick={() => setSheet(true)}>
      New flow
    </Button>
  );

  if (off)
    return (
      <section className={s.page} aria-labelledby="fl-title">
        <header className={s.head}>
          <div className={s.title}>
            <h1 id="fl-title">Flows</h1>
          </div>
        </header>
        <div className={s.off} role="status">
          <p>{off}</p>
          <Link href="/settings/integrations#instagram" className={s.open}>
            Open Integrations
          </Link>
        </div>
      </section>
    );

  const t: FlowCounts | null = sum?.total ?? null;
  const headline = !t
    ? "What your flows did"
    : t.triggered > 0
      ? `Flows answered ${n(t.triggered)} ${t.triggered === 1 ? "conversation" : "conversations"}. ${n(t.leads)} became ${t.leads === 1 ? "a lead" : "leads"}.`
      : "No one started a flow in these days.";
  // Money only for someone who sees it: the API leaves it out otherwise.
  const seesMoney = sum ? sum.total.revenue !== null && !!currency : false;
  const heads = HEADS.filter((h) => h.key !== "revenue" || seesMoney);

  return (
    <section className={s.page} aria-labelledby="fl-title">
      <header className={s.head}>
        <div className={s.title}>
          <h1 id="fl-title">Flows</h1>
          <p>
            Each flow answers a comment, a DM, a story reply or an ad click in seconds, then hands over to
            your team.
          </p>
        </div>
        <SegmentedControl label="Days" size="sm" value={range} options={RANGES} onChange={setRange} />
        {create}
      </header>

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}

      {failed && !flows && (
        <ErrorState
          message="LUME couldn't get your flows. Check your connection and try again."
          action={{ label: "Try again", onClick: () => void load() }}
        />
      )}

      {!failed && !flows && (
        <div className={s.loading} role="status" aria-label="Loading flows" aria-busy="true">
          <Skeleton width="50%" height={22} />
          <Skeleton width="100%" height={88} radius={14} />
          <Skeleton width="100%" height={220} radius={14} />
        </div>
      )}

      {flows && flows.length === 0 && (
        <EmptyState
          title="No flows yet"
          body="A flow answers a comment or a DM in seconds, asks what you'd ask, and hands the person to your team."
          action={create}
        />
      )}

      {flows && flows.length > 0 && (
        <>
          <h2 className={s.headline} aria-live="polite">
            {headline}
          </h2>
          {sumFailed && (
            <p role="status" className={s.note}>
              LUME couldn't count these days just now. The list is as it is; the numbers come back on a
              reload.
            </p>
          )}
          {sum && <FlowsBoard sum={sum} flows={flows} days={Number(range)} currency={currency} />}

          <div className={s.tableWrap} role="region" aria-label="Flows, scrolls sideways" tabIndex={0}>
            <table className={s.table} aria-label="Every flow">
              <thead>
                <tr>
                  {heads.map((h) => (
                    <th
                      key={h.key}
                      scope="col"
                      aria-sort={
                        sort?.key === h.key ? (sort.dir < 0 ? "descending" : "ascending") : undefined
                      }
                      className={h.key === "name" ? s.nameCol : s.numCol}
                    >
                      <button
                        type="button"
                        className={s.sortBtn}
                        onClick={() =>
                          setSort((x) => ({
                            key: h.key,
                            dir: x?.key === h.key ? (-x.dir as 1 | -1) : h.key === "name" ? 1 : -1,
                          }))
                        }
                      >
                        {h.label}
                      </button>
                    </th>
                  ))}
                  <th scope="col" className={s.onCol}>
                    On
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ f, c }) => {
                  const st = startsWith(f);
                  const Icon = st.kind ? TRIGGER_ICONS[st.kind] : null;
                  return (
                    <tr key={f.id}>
                      <th scope="row" className={s.nameCol}>
                        <Link href={`/instagram/flows/${f.id}`} className={s.name} title={f.name}>
                          {f.name}
                        </Link>
                        <span className={s.trig}>
                          {Icon && <Icon size={ICON_SIZE.sm} aria-hidden />}
                          <span>{st.words}</span>
                          {f.status === "draft" && <span className={s.draft}>Draft</span>}
                          {f.status === "paused" && <span className={s.paused}>Off</span>}
                        </span>
                      </th>
                      <td className={s.numCol}>{f.status === "draft" ? DASH : n(f.active)}</td>
                      <td className={s.numCol}>{c && c.triggered ? n(c.triggered) : DASH}</td>
                      <td className={s.numCol}>{c ? pct(c.finished, c.triggered) : DASH}</td>
                      <td className={s.numCol}>{c && c.triggered ? n(c.leads) : DASH}</td>
                      <td className={s.numCol}>{c ? pct(c.leads, c.triggered) : DASH}</td>
                      <td className={s.numCol}>{c && c.triggered ? n(c.won) : DASH}</td>
                      {seesMoney && (
                        <td className={s.numCol}>
                          {c && c.triggered && c.revenue !== null && currency
                            ? money(c.revenue, currency)
                            : DASH}
                        </td>
                      )}
                      <td className={s.onCol}>
                        {f.status === "draft" ? (
                          <Link href={`/instagram/flows/${f.id}`} className={s.open}>
                            Publish
                          </Link>
                        ) : (
                          <Switch
                            checked={f.status === "live"}
                            onChange={(v) => void toggle(f, v)}
                            disabled={switching === f.id}
                            label={`${f.name} is on`}
                            labelHidden
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {sheet && <NewFlowSheet onClose={() => setSheet(false)} />}
    </section>
  );
}
