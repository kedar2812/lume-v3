"use client";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { Quality, Templates } from "@/lib/analytics/client";
import { count, minutes, pct } from "@/lib/analytics/words";
import { Card, Skeleton } from "./parts";
import a from "./analytics.module.css";
import s from "./quality.module.css";

const WAITS = [
  { key: "under_1h", field: "under1h", label: "Under 1 hour", color: "var(--sky)" },
  { key: "under_1d", field: "under1d", label: "1 – 24 hours", color: "var(--accent)" },
  { key: "under_7d", field: "under7d", label: "1 – 7 days", color: "var(--warn)" },
  { key: "over_7d", field: "over7d", label: "Over a week", color: "var(--danger)" },
] as const;

/**
 * Templates & data (canvas Quality): which messages get answered and lead to wins; how many phones LUME can read and
 * the ones to fix; leads nobody has yet and how long they've waited; and what didn't come in cleanly.
 */
export function QualityBoard({
  quality,
  templates,
  rangeWords,
  canManageSources = false,
  onDrill,
}: {
  quality: Quality | null;
  templates: Templates | null;
  rangeWords: string;
  /** integrations.manage: "See the sources" goes somewhere they can open. */
  canManageSources?: boolean;
  onDrill(token: string, title: string): void;
}) {
  if (!quality || !templates)
    return (
      <div className={s.qg}>
        <Skeleton h={260} />
        <Skeleton h={260} i={1} />
      </div>
    );
  const p = quality.phones;
  const u = quality.unowned;
  const waiting = u.under1h + u.under1d + u.under7d + u.over7d;
  const mostWait = Math.max(1, ...WAITS.map((w) => u[w.field]));
  const best = Math.max(0, ...templates.templates.filter((t) => !t.tooFew).map((t) => t.replyRate ?? 0));
  const share = p.readableShare;
  return (
    <>
      <div className={s.qg}>
        <Card
          title="Templates"
          sub={`Messages sent ${rangeWords}, the replies logged within 3 days, and wins within 30`}
        >
          {templates.templates.length === 0 ? (
            <p className={a.empty}>No template messages were sent {rangeWords}.</p>
          ) : (
            <div className={s.scroll}>
              <table className={s.tt}>
                <thead>
                  <tr>
                    <th scope="col">Template</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Replies</th>
                    <th scope="col">Reply rate</th>
                    <th scope="col">Won within 30 days</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.templates.map((t, i) => (
                    <tr key={t.id} style={{ "--i": i } as CSSProperties}>
                      <td>
                        <span className={s.tpl}>
                          <span className={s.tico} aria-hidden>
                            <svg viewBox="0 0 24 24">
                              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.1A8 8 0 1 1 21 12Z" />
                            </svg>
                          </span>
                          <b>{t.name}</b>
                        </span>
                      </td>
                      <td>{count(t.sends)}</td>
                      <td>
                        <span className={s.bw}>
                          {count(t.replies)}
                          <span className={s.tr}>
                            <i
                              data-best={(!t.tooFew && t.replyRate === best && best > 0) || undefined}
                              style={{
                                width: `${best && !t.tooFew ? ((t.replyRate ?? 0) / best) * 100 : 0}%`,
                              }}
                            />
                          </span>
                        </span>
                      </td>
                      <td>
                        {t.tooFew ? (
                          <span className={s.cap}>Too few</span>
                        ) : t.replyRate === null ? (
                          "—"
                        ) : (
                          pct(t.replyRate)
                        )}
                      </td>
                      <td>{count(t.wins)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={s.note}>
            A reply counts when someone logs it on the lead, so these are only as good as your team&rsquo;s
            logging. A win counts for the last template sent before it.
          </p>
        </Card>
        <Card title="Numbers LUME can read" sub="Every lead’s phone, across the business">
          {!p.total ? (
            <p className={a.empty}>No phone numbers yet.</p>
          ) : (
            <div className={s.ph}>
              <div className={s.ring}>
                <svg viewBox="0 0 130 130" aria-hidden>
                  <circle cx="65" cy="65" r="55" className={s.rbg} />
                  <circle
                    cx="65"
                    cy="65"
                    r="55"
                    className={s.rfg}
                    style={{ "--to": 346 - 346 * (share ?? 0) } as CSSProperties}
                  />
                </svg>
                <div className={s.ctr}>
                  <div>
                    <b>{share === null ? "—" : pct(share, 1)}</b>
                    <span>readable</span>
                  </div>
                </div>
              </div>
              <div className={s.fixes}>
                <Fix
                  title="Need a country"
                  sub="Saved without one; one click fixes many"
                  n={p.needsCountry}
                  tone="bad"
                  action="Fix"
                  {...(p.drill.needsCountry
                    ? { onClick: () => onDrill(p.drill.needsCountry!, "Numbers that need a country") }
                    : {})}
                />
                <Fix
                  title="Can’t be read"
                  sub="Too short, or letters in them"
                  n={p.invalid}
                  tone="bad"
                  action="See"
                  {...(p.drill.invalid
                    ? { onClick: () => onDrill(p.drill.invalid!, "Numbers LUME can’t read") }
                    : {})}
                />
                <Fix
                  title="Duplicates merged"
                  sub="Same phone or email, joined into one"
                  n={quality.duplicatesMerged}
                  tone="good"
                />
              </div>
            </div>
          )}
        </Card>
      </div>
      {quality.seesAll === false ? (
        // Unowned leads, sources and imports are the whole business's: never an all-clear to a narrower reach.
        <section
          className={`${a.card} ${s.imports}`}
          aria-label="Leads without an owner, sources and imports"
        >
          <p className={a.empty}>
            Leads without an owner, sources and imports are shown to those who see the whole business.
          </p>
        </section>
      ) : (
        <>
          <div className={s.q3}>
            <section className={`${a.card} ${s.tile}`} aria-label="Nobody yet">
              <span className={s.tIco} data-tone="blue" aria-hidden>
                <svg viewBox="0 0 24 24">
                  <circle cx="10" cy="8" r="4" />
                  <path d="M2 21v-1a6 6 0 0 1 12 0v1M19 8v6M22 11h-6" />
                </svg>
              </span>
              <span className={s.tLabel}>Nobody yet</span>
              <b className={s.tNum}>{count(waiting)}</b>
              <span className={s.tSub}>
                {u.oldestMinutes === null
                  ? "Every lead has someone"
                  : `The oldest has waited ${minutes(u.oldestMinutes)}`}
              </span>
            </section>
            <section className={`${a.card} ${s.tile}`} aria-label="Sources needing a look">
              <span
                className={s.tIco}
                data-tone={quality.sourcesNeedingLook.length ? "amber" : "green"}
                aria-hidden
              >
                <svg viewBox="0 0 24 24">
                  <path d="M12 3 2 20h20L12 3Z" />
                  <path d="M12 10v4M12 17h.01" />
                </svg>
              </span>
              <span className={s.tLabel}>Sources needing a look</span>
              <b className={s.tNum}>{count(quality.sourcesNeedingLook.length)}</b>
              <span className={s.tSub}>
                {quality.sourcesNeedingLook.length === 0
                  ? "Every source is bringing leads in"
                  : quality.sourcesNeedingLook
                      .slice(0, 2)
                      .map(
                        (x) =>
                          `${x.name}: ${x.message ?? (x.status === "paused" ? "paused" : "needs a look")}`,
                      )
                      .join(" · ")}
              </span>
              {canManageSources && quality.sourcesNeedingLook.length > 0 && (
                <Link className={s.tLink} href="/settings/integrations">
                  See the sources
                </Link>
              )}
            </section>
            <Card title="Nobody yet, by how long" sub="Leads without an owner, and how long they’ve waited">
              {!waiting ? (
                <p className={a.empty}>Every lead has someone.</p>
              ) : (
                <div className={s.waits}>
                  {WAITS.map((w, i) => {
                    const n = u[w.field];
                    const token = u.drill[w.key];
                    return (
                      <button
                        key={w.key}
                        type="button"
                        className={s.wcol}
                        disabled={!token || !n}
                        aria-label={`${w.label}: ${count(n)}. See the leads.`}
                        onClick={() => token && onDrill(token, `Nobody yet: ${w.label.toLowerCase()}`)}
                      >
                        <b>{count(n)}</b>
                        <span className={s.wbar}>
                          <i
                            style={
                              {
                                height: `${Math.max(4, (n / mostWait) * 100)}%`,
                                background: w.color,
                                "--i": i,
                              } as CSSProperties
                            }
                          />
                        </span>
                        <span>{w.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
          <section className={`${a.card} ${s.imports}`} aria-label="Imports and sources">
            <div className={a.cardHead}>
              <div>
                <h3>Imports and sources</h3>
                <div className={a.sub}>What didn’t come in cleanly {rangeWords}</div>
              </div>
            </div>
            {!quality.imports.length && !quality.sourcesNeedingLook.length ? (
              <p className={a.empty}>Nothing was imported {rangeWords}, and every source is running.</p>
            ) : (
              <div className={s.chips}>
                {quality.sourcesNeedingLook.map((x) => (
                  <span key={x.id} className={s.chip} data-tone="warn">
                    <b>{x.name}</b>
                    <span className={s.cmsg}>
                      {x.message ?? (x.status === "paused" ? "Paused" : "Needs a look")}
                    </span>
                    <em>{x.status === "paused" ? "Paused" : "Needs a look"}</em>
                  </span>
                ))}
                {quality.imports.map((x) => (
                  <span key={x.sourceId} className={s.chip}>
                    <b>{x.name}</b>
                    <span className={s.cmsg}>{count(x.rows)} rows</span>
                    {x.rejected ? (
                      <em data-tone="bad">
                        {count(x.rejected)} <small>didn’t come in</small>
                      </em>
                    ) : (
                      <em data-tone="good">
                        {count(x.rows)} <small>imported</small>
                      </em>
                    )}
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Fix({
  title,
  sub,
  n,
  tone,
  action,
  onClick,
}: {
  title: string;
  sub: string;
  n: number;
  tone: "bad" | "good";
  action?: string;
  onClick?: () => void;
}) {
  return (
    <div className={s.fix}>
      <div>
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <em data-tone={n ? tone : "none"}>{count(n)}</em>
      {action && n > 0 && onClick ? (
        <button
          type="button"
          className={s.fixBtn}
          aria-label={`${action}: ${title.toLowerCase()}`}
          onClick={onClick}
        >
          {action}
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
