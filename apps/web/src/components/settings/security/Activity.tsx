"use client";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { shortDate, timeOf } from "@/lib/dates";
import { usersClient } from "@/lib/settings/people";
import type { SecurityActivity } from "@/lib/settings/security";
import s from "./activity.module.css";

const num = (n: number) => n.toLocaleString("en-US");
const audit = (q: Record<string, string>) => `/settings/audit?${new URLSearchParams(q).toString()}`;

/** Today's leads opened against the median of the 14 days before, in words. */
export function usualWords(count: number, usual: number): string {
  // A handful either way says nothing: no comparison until there's something to compare.
  if (count < 10 && usual < 10) return count === 0 ? "none yet" : count === 1 ? "just one" : "a few";
  if (usual === 0) return "more than usual";
  const ratio = count / usual;
  if (ratio >= 1.5) return `${ratio >= 2 ? Math.round(ratio) : Math.round(ratio * 10) / 10}× usual`;
  if (ratio <= 0.5) return "quieter than usual";
  return "about usual";
}

/**
 * Security activity (6C, canvas [Main]), under the alerts for people who may read the audit log: today's four
 * figures, contacts opened per person over 14 days (today emphasised: blue, or amber when they had an alert
 * today), and who is signed in now. Every number opens the Audit log at its own entries.
 */
export function Activity({
  data,
  timezone,
  canManagePeople,
}: {
  data: SecurityActivity;
  timezone: string;
  canManagePeople: boolean;
}) {
  const t = data.today;
  const exportsBy =
    t.exports.count === 0
      ? "none yet"
      : t.exports.by
        ? `${t.exports.count === 1 ? "by" : t.exports.count === 2 ? "both by" : "all by"} ${t.exports.by}`
        : "by several people";
  const failedBy =
    t.failedSignIns.count === 0
      ? "none"
      : t.failedSignIns.name
        ? `${t.failedSignIns.count === 1 ? "" : "all "}${t.failedSignIns.name}${t.failedSignIns.thenSignedIn ? ", then signed in" : ""}`
        : "from several accounts";

  return (
    <>
      <section className={s.tiles} aria-label="Today">
        <Tile
          href={audit({ action: "lead.contact.reveal", day: t.day })}
          label="Contacts opened today"
          value={t.reveals.count}
          detail={
            t.reveals.people === 0
              ? "nobody yet"
              : `by ${t.reveals.people} ${t.reveals.people === 1 ? "person" : "people"}`
          }
        />
        <Tile
          href={audit({ action: "lead.view", day: t.day })}
          label="Leads opened today"
          value={t.leadsOpened.count}
          detail={usualWords(t.leadsOpened.count, t.leadsOpened.usual)}
        />
        <Tile
          href="/settings/security/exports"
          label="Exports this week"
          value={t.exports.count}
          detail={exportsBy}
        />
        <Tile
          href={audit({ action: "user.login.failed", day: t.day })}
          label="Failed sign-ins today"
          value={t.failedSignIns.count}
          detail={failedBy}
        />
      </section>

      <section className={s.panel} aria-labelledby="reveals-head">
        <div className={s.head}>
          <h3 id="reveals-head">Contacts opened, per person</h3>
          <span className={s.cap}>last 14 days · today in blue</span>
        </div>
        {data.reveals.length === 0 ? (
          <p className={s.empty}>Nobody has opened a contact in the last 14 days.</p>
        ) : (
          <RevealChart rows={data.reveals} />
        )}
      </section>

      <LiveSessions sessions={data.sessions} timezone={timezone} canManagePeople={canManagePeople} />
    </>
  );
}

function Tile({
  href,
  label,
  value,
  detail,
}: {
  href: string;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <Link className={s.tile} href={href}>
      <span className={s.tileLabel}>{label}</span>
      <span className={s.tileValue}>{num(value)}</span>
      <span className={s.tileDetail}>{detail}</span>
    </Link>
  );
}

/** Small multiples: one row a person, 14 bars on one shared scale so rows compare honestly. */
function RevealChart({ rows }: { rows: SecurityActivity["reveals"] }) {
  const top = Math.max(1, ...rows.flatMap((r) => r.days));
  return (
    <ul className={s.chart} aria-label="Contacts opened, per person">
      {rows.map((r) => {
        const today = r.days.at(-1) ?? 0;
        return (
          <li
            key={r.id}
            className={s.chartRow}
            aria-label={`${r.name}: ${num(r.total)} contacts in 14 days, ${num(today)} today`}
          >
            <Avatar name={r.name} size={30} />
            <span className={s.who}>
              <span className={s.name}>{r.name}</span>
              {r.role && <span className={s.role}>{r.role}</span>}
            </span>
            <span className={s.bars} aria-hidden>
              {r.days.map((n, i) => {
                const isToday = i === r.days.length - 1;
                return (
                  <i
                    key={i}
                    style={{ height: `${Math.max(n ? 8 : 3, (n / top) * 100)}%` }}
                    {...(isToday ? { "data-today": "", "data-tone": r.alertToday ? "warn" : "accent" } : {})}
                  />
                );
              })}
            </span>
            <Link className={s.total} href={audit({ actor: r.id, action: "lead.contact.reveal" })}>
              {num(r.total)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** One row a person: their newest session's device and since when; Sign out ends every session of theirs. */
function LiveSessions({
  sessions,
  timezone,
  canManagePeople,
}: {
  sessions: SecurityActivity["sessions"];
  timezone: string;
  canManagePeople: boolean;
}) {
  const [ended, setEnded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const people = new Map<string, SecurityActivity["sessions"]>();
  for (const x of sessions) people.set(x.userId, [...(people.get(x.userId) ?? []), x]);
  const today = shortDate(new Date(), timezone);
  const since = (iso: string) => {
    const d = new Date(iso);
    return shortDate(d, timezone) === today ? timeOf(d, timezone) : shortDate(d, timezone);
  };
  const live = sessions.filter((x) => !ended.has(x.userId)).length;

  const signOut = async (userId: string) => {
    setBusy(userId);
    setProblem(null);
    const r = await usersClient.endSessions(userId);
    setBusy(null);
    if (!r.ok) return setProblem(r.message);
    setEnded((all) => new Set(all).add(userId));
  };

  return (
    <section className={s.panel} aria-labelledby="sessions-head">
      <div className={s.head}>
        <h3 id="sessions-head">Signed in now</h3>
        <span className={s.cap}>
          {live} {live === 1 ? "session" : "sessions"}
        </span>
      </div>
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <ul className={s.sessions}>
        {/* You first, then everyone else, newest session first. */}
        {[...people.entries()]
          .sort(([, a], [, b]) => Number(b.some((x) => x.you)) - Number(a.some((x) => x.you)))
          .map(([userId, list]) => {
            const mine = list.find((x) => x.you);
            const shown = mine ?? list[0]!;
            const more = list.length > 1 ? ` · ${list.length} sessions` : "";
            const out = ended.has(userId);
            return (
              <li key={userId} className={s.session} data-out={out || undefined}>
                <Avatar name={shown.name} size={30} />
                <span className={s.who}>
                  <span className={s.name}>{shown.name}</span>
                  <span className={s.role}>
                    {mine
                      ? `${shown.device} · this session${more}`
                      : `${shown.device} · since ${since(shown.since)}${more}`}
                  </span>
                </span>
                {mine ? (
                  <span className={s.you}>You</span>
                ) : out ? (
                  <span className={s.outWord}>Signed out</span>
                ) : canManagePeople ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Sign out ${shown.name}`}
                    loading={busy === userId}
                    onClick={() => void signOut(userId)}
                  >
                    Sign out
                  </Button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
      </ul>
    </section>
  );
}
