"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { CloseButton } from "./NewLicence";

type Kind = "update" | "maintenance";
type Who = "everyone" | "admins";
/** A local date and time field's value, as the owner's own clock says it. */
const local = (d: Date) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 16);
};
const isoOf = (v: string) => (v ? new Date(v).toISOString() : null);
const windowWords = (a: string, b: string) => {
  if (!a || !b) return "";
  const s = new Date(a);
  const e = new Date(b);
  const d = s.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const t = (x: Date) => x.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return `${d}, ${t(s)} – ${t(e)}`;
};

/**
 * New announcement (spec 2026-10-16 fleet §3.4): what, for whom, from when to when, with the strip as it will show
 * in LUME, light and dark. Plain text only; it reaches each LUME at its next check-in.
 */
export function AnnouncementSheet({
  clients,
  onClose,
  onPublished,
}: {
  clients: { id: string; name: string }[];
  onClose: () => void;
  onPublished: () => void;
}) {
  const now = useMemo(() => new Date(), []);
  const [kind, setKind] = useState<Kind>("update");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [winStart, setWinStart] = useState("");
  const [winEnd, setWinEnd] = useState("");
  const [who, setWho] = useState<Who>("everyone");
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const [find, setFind] = useState("");
  const [later, setLater] = useState(false);
  const [startsAt, setStartsAt] = useState(local(new Date(now.getTime() + 3_600_000)));
  const [until, setUntil] = useState(local(new Date(now.getTime() + 14 * 86_400_000)));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const maint = kind === "maintenance";
  const can =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (!maint || (winStart && winEnd)) &&
    (all || chosen.length > 0) &&
    !!until;
  const shown = clients.filter((c) => c.name.toLowerCase().includes(find.trim().toLowerCase()));
  const toggle = (id: string) => setChosen((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));

  const publish = async () => {
    if (!can || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await api.post("/api/announcements", {
      title: title.trim(),
      body: body.trim(),
      kind,
      windowStart: maint ? isoOf(winStart) : null,
      windowEnd: maint ? isoOf(winEnd) : null,
      audience: who,
      clients: all ? "all" : chosen,
      startsAt: later ? isoOf(startsAt) : null,
      endsAt: isoOf(until),
    });
    setBusy(false);
    if (r.ok) onPublished();
    else setProblem(r.message);
  };

  const Strip = ({ dark }: { dark?: boolean }) => (
    <div className={`fl-strip${dark ? " fl-strip-dark" : ""}`}>
      <i style={{ background: maint ? "#f2a20c" : "#2a5bff" }} aria-hidden />
      <span>
        <small>From LUME’s team</small>
        <b>{title.trim() || "Title"}</b>
        {maint && winStart && winEnd && <em>{windowWords(winStart, winEnd)}</em>}
        <span>{body.trim() || "Message"}</span>
      </span>
    </div>
  );

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden />
      <form
        className="sheet fl-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="New announcement"
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
      >
        <div className="top">
          New announcement
          <CloseButton onClose={onClose} />
        </div>
        <div className="mid">
          <div className="field">
            Kind
            <div className="chips" role="radiogroup" aria-label="Kind">
              {(
                [
                  ["update", "Update"],
                  ["maintenance", "Maintenance"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className="chip"
                  role="radio"
                  aria-checked={kind === v}
                  onClick={() => setKind(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {maint && (
            <div className="fl-two">
              <label className="field">
                Maintenance starts
                <input className="input" type="datetime-local" value={winStart} onChange={(e) => setWinStart(e.target.value)} />
              </label>
              <label className="field">
                Ends
                <input className="input" type="datetime-local" value={winEnd} onChange={(e) => setWinEnd(e.target.value)} />
              </label>
            </div>
          )}
          <label className="field">
            Title
            <input
              className="input"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="LUME will be updated on Saturday night"
            />
          </label>
          <label className="field">
            Message
            <textarea
              className="input fl-area"
              value={body}
              maxLength={600}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What changes for them, and when."
            />
            {body.length >= 500 && <span className="note fl-count">{body.length} of 600</span>}
          </label>
          <div className="field">
            Who sees it in LUME
            <div className="chips" role="radiogroup" aria-label="Who sees it">
              {(
                [
                  ["everyone", "Everyone"],
                  ["admins", "Admins only"],
                ] as const
              ).map(([v, label]) => (
                <button key={v} type="button" className="chip" role="radio" aria-checked={who === v} onClick={() => setWho(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            Which clients
            <div className="chips" role="radiogroup" aria-label="Which clients">
              <button type="button" className="chip" role="radio" aria-checked={all} onClick={() => setAll(true)}>
                All clients
              </button>
              <button type="button" className="chip" role="radio" aria-checked={!all} onClick={() => setAll(false)}>
                Choose…
              </button>
            </div>
            {!all && (
              <div className="fl-pick">
                <input
                  className="input"
                  type="search"
                  aria-label="Find a client"
                  placeholder="Find a client"
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                />
                <div className="fl-pick-list">
                  {shown.map((c) => (
                    <label key={c.id} className="fl-check">
                      <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => toggle(c.id)} />
                      {c.name}
                    </label>
                  ))}
                  {!shown.length && <span className="note">No client by that name.</span>}
                </div>
              </div>
            )}
          </div>
          <div className="fl-two">
            <div className="field">
              Shows from
              <div className="chips" role="radiogroup" aria-label="Shows from">
                <button type="button" className="chip" role="radio" aria-checked={!later} onClick={() => setLater(false)}>
                  Now
                </button>
                <button type="button" className="chip" role="radio" aria-checked={later} onClick={() => setLater(true)}>
                  Later
                </button>
              </div>
              {later && (
                <input
                  className="input"
                  type="datetime-local"
                  aria-label="Shows from"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              )}
            </div>
            <label className="field">
              Until
              <input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            </label>
          </div>
          <div className="field">
            How it looks in LUME
            <Strip />
            <Strip dark />
          </div>
          <p className="fl-plain">
            Reaches each LUME at its next check-in, within 6 hours. LUMEs on an older version won’t show it.
          </p>
          {problem && (
            <p role="alert" className="fl-prob fl-red">
              {problem}
            </p>
          )}
        </div>
        <div className="foot">
          <button type="button" className="btn second" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!can || busy}>
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
      </form>
    </>
  );
}
