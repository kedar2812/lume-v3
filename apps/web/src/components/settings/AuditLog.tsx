"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { Person } from "@/lib/leads/types";
import { accessGone } from "@/lib/settings/access";
import {
  AUDIT_ACTIONS,
  auditClient,
  auditPhrase,
  type AuditEntry,
  type AuditQuery,
} from "@/lib/settings/audit";
import { shortDateTime } from "@/lib/settings/format";
import { AccessChanged } from "./AccessChanged";
import s from "./settings.module.css";

const AREAS = [...new Set(Object.values(AUDIT_ACTIONS).map((a) => a.area))];
const verb = (key: string) => {
  const p = AUDIT_ACTIONS[key]!.phrase;
  const text = typeof p === "string" ? p : p({ updated: "several", from: "", to: "" });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Everything that happened in LUME, newest first, in words: who did what, and when. Filter by person
 * and by action; older entries load on request. Nobody can edit or delete it, the owner included.
 */
export function AuditLog({ people }: { people: Person[] }) {
  const [filters, setFilters] = useState<Omit<AuditQuery, "cursor">>({});
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [state, setState] = useState<"ready" | "loading" | "error" | "gone">("loading");

  const load = useCallback(async (f: Omit<AuditQuery, "cursor">, after?: number) => {
    setState("loading");
    const r = await auditClient.list(after ? { ...f, cursor: after } : f);
    if (!r.ok) return setState(accessGone(r) ? "gone" : "error");
    setEntries((prev) => (after ? [...(prev ?? []), ...r.data.entries] : r.data.entries));
    setCursor(r.data.nextCursor);
    setState("ready");
  }, []);

  useEffect(() => {
    void load({});
  }, [load]);

  if (state === "gone") return <AccessChanged />;

  const setFilter = (patch: Partial<AuditQuery>) => {
    const next = Object.fromEntries(Object.entries({ ...filters, ...patch }).filter(([, v]) => v)) as Omit<
      AuditQuery,
      "cursor"
    >;
    setFilters(next);
    void load(next);
  };

  return (
    <div className={s.stack}>
      <p className={s.lockNote}>The audit log can’t be edited or deleted, by anyone.</p>
      <div className={s.auditFilters}>
        <label>
          <span>Who</span>
          <select
            value={filters.actorUserId ?? ""}
            onChange={(e) => setFilter({ actorUserId: e.target.value })}
          >
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>What</span>
          <select value={filters.action ?? ""} onChange={(e) => setFilter({ action: e.target.value })}>
            <option value="">Anything</option>
            {AREAS.map((area) => (
              <optgroup key={area} label={area}>
                {Object.keys(AUDIT_ACTIONS)
                  .filter((k) => AUDIT_ACTIONS[k]!.area === area)
                  .map((k) => (
                    <option key={k} value={k}>
                      {verb(k)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <section className={s.panel} aria-label="Audit entries">
        {entries === null ? (
          <p className={`${s.muted} ${s.panelBody}`}>Loading…</p>
        ) : entries.length === 0 ? (
          <p className={`${s.muted} ${s.panelBody}`}>
            {Object.keys(filters).length ? "Nothing matches these filters." : "Nothing has happened yet."}
          </p>
        ) : (
          <ol className={s.auditList}>
            {entries.map((e) => (
              <li key={e.id} className={s.auditRow}>
                <span className={s.auditText}>{auditPhrase(e, people)}</span>
                {e.entityType === "lead" && e.entityId && e.action !== "lead.delete" && (
                  <Link className={s.auditLink} href={`/leads?lead=${e.entityId}`}>
                    Open lead
                  </Link>
                )}
                <time className={s.auditTime} dateTime={e.at}>
                  {shortDateTime(e.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
      {state === "error" && (
        <p role="alert" className={s.problem}>
          The audit log couldn’t load. Try again in a moment.
        </p>
      )}
      {cursor !== null && (
        <Button
          variant="secondary"
          className={s.addPackage}
          loading={state === "loading"}
          onClick={() => void load(filters, cursor)}
        >
          Load earlier
        </Button>
      )}
    </div>
  );
}
