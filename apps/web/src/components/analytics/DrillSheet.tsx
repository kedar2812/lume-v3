"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Scrim } from "@/components/ui/Scrim";
import { useModalFocus } from "@/components/ui/useModalFocus";
import { analyticsClient } from "@/lib/analytics/client";
import { tokenColor } from "@/lib/leads/colors";
import type { Catalog, Lead } from "@/lib/leads/types";
import { useLoadingSignal } from "@/lib/loading";
import { count, money } from "@/lib/analytics/words";
import { Ico, Skeleton } from "./parts";
import s from "./analytics.module.css";

/**
 * The leads behind a number (8C, canvas Main's drill-down): a glass sheet over the whole window. The list comes from
 * the Leads list itself, so it never shows more than the person may see, masked as they'd see it.
 */
export function DrillSheet({
  token,
  title,
  facts,
  catalog,
  onClose,
}: {
  token: string;
  title: string;
  facts: string[];
  catalog: Catalog;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Lead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const focus = useModalFocus(panel, onClose);
  useLoadingSignal(rows === null || more);

  useEffect(() => {
    let live = true;
    void analyticsClient.drill(token).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setRows(r.data.items);
      setTotal(r.data.total);
      setCursor(r.data.nextCursor);
    });
    return () => {
      live = false;
    };
  }, [token]);
  const loadMore = async () => {
    if (!cursor) return;
    setMore(true);
    const r = await analyticsClient.drill(token, cursor);
    setMore(false);
    if (!r.ok) return setError(r.message);
    setRows((x) => [...(x ?? []), ...r.data.items]);
    setCursor(r.data.nextCursor);
  };
  const stages = catalog.pipelines.flatMap((p) => p.stages);
  const person = (id: string | null | undefined) =>
    catalog.people.find((p) => p.id === id)?.name ?? "Nobody yet";

  return (
    <Scrim onClose={onClose}>
      <aside
        ref={panel}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`The leads behind it: ${title}`}
        onKeyDown={focus.onKeyDown}
      >
        <div className={s.sheetHead}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={s.eyebrow}>The leads behind it</div>
            <div className={s.sheetTitle}>{title}</div>
            <div className={s.facts}>
              {facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
              {rows && (
                <span>
                  {count(total)} {total === 1 ? "lead" : "leads"}
                </span>
              )}
            </div>
          </div>
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
            {Ico.close}
          </button>
        </div>
        <div className={s.sheetList} aria-busy={rows === null || undefined}>
          {error ? (
            <p className={s.empty} role="alert">
              {error}
            </p>
          ) : rows === null ? (
            Array.from({ length: 8 }, (_, i) => (
              <div key={i} style={{ padding: "6px 10px" }}>
                <Skeleton h={38} i={i} />
              </div>
            ))
          ) : rows.length === 0 ? (
            <p className={s.empty}>No leads you can see are behind this number.</p>
          ) : (
            rows.map((l, i) => {
              const st = stages.find((x) => x.id === l.stageId);
              return (
                <Link
                  key={l.id}
                  href={`/leads?lead=${l.id}`}
                  className={s.leadRow}
                  style={{ "--i": Math.min(i, 20) } as CSSProperties}
                >
                  <Avatar name={l.name ?? "?"} size={30} />
                  <div style={{ minWidth: 0 }}>
                    <b>{l.name ?? "—"}</b>
                    <small>
                      {person(l.ownerId)}
                      {st ? (
                        <>
                          {" · "}
                          <span style={{ color: tokenColor(st.color) }}>●</span> {st.name}
                        </>
                      ) : null}
                    </small>
                  </div>
                  <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {l.value !== null && l.value !== undefined
                      ? money(Number(l.value), catalog.currency, false)
                      : ""}
                  </span>
                </Link>
              );
            })
          )}
          {more && <Skeleton h={38} />}
        </div>
        <div className={s.sheetFoot}>
          {cursor && (
            <Button onClick={() => void loadMore()} loading={more}>
              Show more
            </Button>
          )}
          <span className={s.cap}>Only what you’re allowed to see</span>
        </div>
      </aside>
    </Scrim>
  );
}
