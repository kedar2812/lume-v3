"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useId, useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui/Button";
import { dateTime, shortDate, timeOf } from "@/lib/dates";
import { SPRINGS, toMotion } from "@/lib/motion";
import { securityClient, type ExportRow, type TraceMatch } from "@/lib/settings/security";
import s from "./security.module.css";

type Phase =
  | { kind: "idle" }
  | { kind: "reading"; name: string }
  | { kind: "found"; match: TraceMatch }
  | { kind: "none" }
  | { kind: "error"; message: string };

const FORMAT = { csv: "CSV", xlsx: "Excel" } as const;
const n = (x: number) => x.toLocaleString("en-US");

/** "Once, at 4:13 pm, from Chrome · Mac"; "3 times, last at …"; or not yet. */
function downloadsInWords(d: TraceMatch["downloads"], tz: string): string {
  if (!d.length) return "Not downloaded yet";
  const last = d.at(-1)!;
  const at = timeOf(new Date(last.at), tz);
  return d.length === 1
    ? `Once, at ${at}, from ${last.device}`
    : `${d.length} times, last at ${at}, from ${last.device}`;
}

/**
 * Settings → Security → Exports (6B, canvas [Exports]): give LUME a file found outside the business and it says
 * whose export it was — by its LUME ref column, or by the hidden check row — or plainly that nothing matches.
 * Then every export of the last 90 days, with the time each file has left.
 */
export function ExportsTab({
  initial,
  timezone,
  viewerId,
  now = new Date(),
}: {
  initial: ExportRow[];
  timezone: string;
  viewerId: string;
  now?: Date;
}) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const codeId = useId();

  const answer = (r: Awaited<ReturnType<typeof securityClient.traceCode>>) => {
    if (!r.ok) return setPhase({ kind: "error", message: r.message });
    setPhase(r.data.match ? { kind: "found", match: r.data.match } : { kind: "none" });
  };
  const read = async (file: File | undefined) => {
    if (!file) return;
    setPhase({ kind: "reading", name: file.name });
    answer(await securityClient.traceFile(file));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void read(e.dataTransfer?.files?.[0]);
  };
  const again = () => {
    setPhase({ kind: "idle" });
    setCode("");
    if (input.current) input.current.value = "";
  };

  return (
    <div className={s.stack}>
      <div>
        <h2 className={s.h3}>Where did this file come from?</h2>
        <p className={s.sub}>
          Every export carries a hidden mark. Give LUME a file you found outside the business, and it tells
          you whose export it was.
        </p>
      </div>
      <section className={s.trace}>
        <div
          data-testid="trace-drop"
          className={s.drop}
          data-idle={phase.kind === "idle" || undefined}
          data-over={over || undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={phase.kind}
              className={s.dropInner}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={toMotion(SPRINGS.default)}
            >
              {phase.kind === "idle" && (
                <>
                  <span className={s.dropIcon} aria-hidden>
                    <svg viewBox="0 0 24 24" width="22" height="22">
                      <path
                        d="M12 15V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <b>Drop a CSV or Excel file here</b>
                  <span className={s.cap}>LUME reads it and forgets it. Nothing is kept.</span>
                  <label htmlFor={inputId} className={s.chooseFile}>
                    Choose a file
                  </label>
                  <input
                    id={inputId}
                    ref={input}
                    type="file"
                    accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className={s.srOnly}
                    onChange={(e) => void read(e.target.files?.[0])}
                  />
                </>
              )}
              {phase.kind === "reading" && (
                <>
                  <span className={s.scanBar} aria-hidden />
                  <span className={s.cap} role="status">
                    Reading {phase.name}…
                  </span>
                </>
              )}
              {phase.kind === "found" && <Found match={phase.match} timezone={timezone} onAgain={again} />}
              {phase.kind === "none" && (
                <div className={s.found}>
                  <b>No LUME export matches this file</b>
                  <span className={s.cap}>It may have been copied by hand, or come from somewhere else.</span>
                  <Button size="sm" variant="ghost" onClick={again}>
                    Check another file
                  </Button>
                </div>
              )}
              {phase.kind === "error" && (
                <div className={s.found}>
                  <p role="alert" className={s.problem}>
                    {phase.message}
                  </p>
                  <Button size="sm" variant="ghost" onClick={again}>
                    Check another file
                  </Button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className={s.traceSide}>
          <form
            className={s.codeForm}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!code.trim()) return;
              setPhase({ kind: "reading", name: code.trim().toUpperCase() });
              answer(await securityClient.traceCode(code.trim()));
            }}
          >
            <label htmlFor={codeId}>Or type the code from its LUME ref column</label>
            <input
              id={codeId}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PX7Q-4MRA"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={!code.trim()}>
              Look it up
            </Button>
          </form>
          <p className={s.how}>
            <b>How the mark works.</b> Each export has a code on every row, and one made-up lead only LUME
            recognises. If a file still has either, LUME can say whose export it was. If both were removed, or
            the rows were retyped, LUME says so instead of guessing.
          </p>
        </div>
      </section>

      <section className={s.panel}>
        <div className={s.panelHead}>
          <h2 className={s.h3}>Exports</h2>
          <span className={s.cap}>
            Files disappear 24 hours after they’re made. Every download is recorded.
          </span>
        </div>
        {initial.length === 0 ? (
          <p className={`${s.cap} ${s.panelEmpty}`}>Nobody has exported leads in the last 90 days.</p>
        ) : (
          <ul className={s.exportList} aria-label="Exports">
            {initial.map((x) => {
              const hours = Math.ceil((Date.parse(x.expiresAt) - now.getTime()) / 3_600_000);
              const live = x.available && hours > 0;
              return (
                <li key={x.id} className={s.exportRow}>
                  <span className={s.avatar} aria-hidden>
                    {x.who.initials}
                  </span>
                  <span className={s.alertText}>
                    <b>
                      {x.label} · {n(x.rows)} leads · {FORMAT[x.format]}
                    </b>
                    <span className={s.detail}>
                      {x.who.name} · {shortDate(new Date(x.createdAt), timezone)},{" "}
                      {timeOf(new Date(x.createdAt), timezone)} · {x.downloads}{" "}
                      {x.downloads === 1 ? "download" : "downloads"}
                    </span>
                  </span>
                  <code className={s.code}>{x.code}</code>
                  <span className={live ? s.left : s.expired}>
                    {live ? (hours <= 1 ? "Under an hour left" : `${hours} h left`) : "Expired"}
                  </span>
                  {live && x.who.id === viewerId ? (
                    <a
                      className={s.download}
                      href={`/api/v1/leads/exports/${x.id}/download`}
                      aria-label={`Download ${x.label}`}
                    >
                      Download
                    </a>
                  ) : (
                    <span className={s.cap}>{live ? "" : "File deleted"}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Found({ match, timezone, onAgain }: { match: TraceMatch; timezone: string; onAgain: () => void }) {
  const titleId = useId();
  return (
    <section className={s.found} aria-labelledby={titleId}>
      <div className={s.foundHead}>
        <span className={s.avatar} aria-hidden>
          {match.who.name
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w[0])
            .join("")}
        </span>
        <div>
          <b id={titleId}>{match.who.name}’s export</b>
          <span className={s.cap}>
            {dateTime(new Date(match.createdAt), timezone)} · code {match.code}
          </span>
        </div>
      </div>
      <dl className={s.facts}>
        <dt>What</dt>
        <dd>
          {match.label}, {n(match.rows)} leads, as {FORMAT[match.format]}
        </dd>
        <dt>Downloaded</dt>
        <dd>{downloadsInWords(match.downloads, timezone)}</dd>
        <dt>Found by</dt>
        <dd>
          {match.foundBy === "column"
            ? "The LUME ref column"
            : "A hidden check row. Someone deleted the LUME ref column, but the row stayed."}
        </dd>
      </dl>
      <div className={s.foundActions}>
        <Link className={s.auditLink} href={`/settings/audit?actor=${match.who.id}`}>
          Open the audit log
        </Link>
        <Button size="sm" variant="ghost" onClick={onAgain}>
          Check another file
        </Button>
      </div>
    </section>
  );
}
