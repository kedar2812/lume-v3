"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/PasswordInput";
import type { Person } from "@/lib/leads/types";
import { accessGone } from "@/lib/settings/access";
import {
  AUDIT_ACTIONS,
  auditClient,
  auditPhrase,
  type AuditEntry,
  type AuditQuery,
} from "@/lib/settings/audit";
import { longDate } from "@/lib/dates";
import { settingsDateTime } from "@/lib/settings/format";
import { useZone } from "@/components/ZoneProvider";
import { AccessChanged } from "./AccessChanged";
import o from "./offboard.module.css";
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
export function AuditLog({
  people,
  initialActor,
  initialAction,
  initialDay,
  canExport = false,
}: {
  people: Person[];
  /** Download CSV, for whoever holds audit.export (owner 2026-11-14). */
  canExport?: boolean;
  initialActor?: string;
  initialAction?: string;
  initialDay?: string;
}) {
  const tz = useZone();
  // Opened from a security alert (6A) or a Security figure (6C): already filtered to that person, action or day.
  const [start] = useState<Omit<AuditQuery, "cursor">>(() =>
    Object.fromEntries(
      Object.entries({ actorUserId: initialActor, action: initialAction, day: initialDay }).filter(
        ([, v]) => v,
      ),
    ),
  );
  const [filters, setFilters] = useState<Omit<AuditQuery, "cursor">>(start);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [state, setState] = useState<"ready" | "loading" | "error" | "gone">("loading");
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async (f: Omit<AuditQuery, "cursor">, after?: number) => {
    setState("loading");
    const r = await auditClient.list(after ? { ...f, cursor: after } : f);
    if (!r.ok) return setState(accessGone(r) ? "gone" : "error");
    setEntries((prev) => (after ? [...(prev ?? []), ...r.data.entries] : r.data.entries));
    setCursor(r.data.nextCursor);
    setState("ready");
  }, []);

  useEffect(() => {
    void load(start);
  }, [load, start]);

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
        {/* The log as a spreadsheet, with these filters, every entry (owner 2026-11-14). */}
        {canExport && (
          <button type="button" className={s.auditExport} onClick={() => setDownloading(true)}>
            <UI_ICONS.download size={ICON_SIZE.md} aria-hidden />
            Download CSV
          </button>
        )}
        {downloading && <AuditDownload filters={filters} onClose={() => setDownloading(false)} />}
        {filters.day && (
          <span className={s.auditDay}>
            Only {longDate(new Date(`${filters.day}T12:00:00Z`), "UTC")}
            <button type="button" className={s.auditDayAll} onClick={() => setFilter({ day: undefined })}>
              Show every day
            </button>
          </span>
        )}
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
                  {settingsDateTime(e.at, tz)}
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

/** Download CSV asks for the password first (owner 2026-11-17), then the browser takes the file. */
function AuditDownload({ filters, onClose }: { filters: Omit<AuditQuery, "cursor">; onClose(): void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setProblem(null);
    const r = await auditClient.csvTicket(password);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    window.location.assign(auditClient.csvHref(filters, r.data.ticket));
    onClose();
  };
  return (
    <Dialog label="Download the audit log" onClose={busy ? () => undefined : onClose}>
      <form
        className={o.sheet}
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void go();
        }}
      >
        <header className={o.head}>
          <div>
            <h2 className={o.title}>Download the audit log</h2>
            <p className={o.sub}>Enter your password to download it, with the filters on screen.</p>
          </div>
        </header>
        <Field label="Password">
          {(control) => (
            <PasswordInput
              {...control}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          )}
        </Field>
        {problem && (
          <p role="alert" className={o.problem}>
            {problem}
          </p>
        )}
        <footer className={o.foot}>
          <span className={o.grow} />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} disabled={!password}>
            Download
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
