"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { browserName, bugReport, isBehind, KIND_WORDS, type FeedbackStatus } from "@/lib/feedback";
import { when } from "@/lib/format";
import { FeedbackPill, KindDot, received, type FeedbackItem } from "./FeedbackScreen";
import { Head } from "./Shell";
import { ShotViewer } from "./ShotViewer";

export type FeedbackDetail = Omit<FeedbackItem, "reporter"> & {
  text: string;
  reporter: { name: string; role: string; email: string };
  appVersion: string;
  browser: string;
  screen: string;
  theme: "porcelain" | "obsidian";
  note: string;
  closedAt: string | null;
  imagesRemovedAt: string | null;
  images: { n: number; type: string; width: number; height: number }[];
  latestRelease: string | null;
  clientVersion: string | null;
};
type Choice = Exclude<FeedbackStatus, "new">;
const CHOICES: { value: Choice; label: string }[] = [
  { value: "seen", label: "Seen" },
  { value: "fixing", label: "Fixing" },
  { value: "fixed", label: "Fixed in…" },
  { value: "not_a_bug", label: "Not a bug" },
];
const back = (
  <Link className="back" href="/feedback">
    ← Feedback
  </Link>
);

/** One report (spec 2026-10-16 §3.3): the words, the screenshots, where it's got to, and the owner's own note. */
export function FeedbackReport({ id }: { id: string }) {
  const [d, setD] = useState<FeedbackDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [version, setVersion] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = async (body: Record<string, string>) => {
    const r = await api.patch<FeedbackDetail>(`/api/feedback/${id}`, body);
    if (r.ok) {
      // A note saved while the owner kept typing keeps what's in the box now.
      setD((prev) => (body.note !== undefined && prev ? { ...r.data, note: prev.note } : r.data));
      setProblem(null);
    } else setProblem(r.message);
    return r.ok;
  };
  useEffect(() => {
    let live = true;
    void api.get<FeedbackDetail>(`/api/feedback/${id}`).then(async (r) => {
      if (!live) return;
      if (!r.ok) return setMissing(true);
      setD(r.data);
      // Opened: it's no longer new.
      if (r.data.status === "new") await patch({ status: "seen" });
    });
    return () => {
      live = false;
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, [id]);

  if (missing)
    return (
      <>
        <Head title="Feedback" back={back} />
        <div className="body">
          <p className="note">
            No such report. <Link href="/feedback">Back to Feedback</Link>
          </p>
        </div>
      </>
    );
  if (!d)
    return (
      <>
        <Head title="Feedback" back={back} />
        <div className="body" aria-busy>
          <div className="fb-loading" aria-hidden />
        </div>
      </>
    );

  const choose = (v: Choice) => {
    if (v === "fixed") {
      setVersion(d.fixedIn ?? d.latestRelease ?? "");
      setAsking(true);
      return;
    }
    setAsking(false);
    void patch({ status: v });
  };
  const onNote = (note: string) => {
    setD({ ...d, note });
    setSaved(false);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => void patch({ note }).then(setSaved), 600);
  };
  const copy = async () => {
    await navigator.clipboard.writeText(bugReport(d));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  const label = `${d.client.name} · ${d.reporter.name} · ${d.page}`;
  const historyLine =
    d.status === "fixed"
      ? `Written to ${d.client.name}'s history: “Feedback marked Fixed in ${d.fixedIn}”. Releases counts it under ${d.fixedIn}.`
      : d.status === "fixing"
        ? `Written to ${d.client.name}'s history: “Feedback marked Fixing”.`
        : d.status === "not_a_bug"
          ? "Closed. Choose Seen to reopen it."
          : "Opened, so it's no longer new.";

  return (
    <>
      <Head title={`${d.client.name} · ${d.reporter.name}`} back={back}>
        <button type="button" className="btn second" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy as bug report"}
        </button>
      </Head>
      <div className="body">
        <div className="fb-meta">
          <span className={`pill fb-k-${d.kind}`}>
            <KindDot kind={d.kind} />
            {KIND_WORDS[d.kind]}
          </span>
          <FeedbackPill status={d.status} fixedIn={d.fixedIn} />
          <span className="note">
            Received {received(d.receivedAt)} · {when(d.receivedAt)}
          </span>
        </div>
        <div className="fb-cols">
          <div className="fb-left">
            <section className="card" aria-label="What happened">
              <h2 className="h">What happened</h2>
              <p className="fb-text">{d.text}</p>
            </section>
            {d.imageCount > 0 && (
              <section className="card" aria-label="Screenshots">
                <h2 className="h">Screenshots</h2>
                {d.imagesRemovedAt ? (
                  <p className="note">Screenshots removed 90 days after this was closed.</p>
                ) : (
                  <>
                    <div className="fb-thumbs">
                      {d.images.map((s, i) => (
                        <button
                          key={s.n}
                          type="button"
                          className="fb-thumb"
                          onClick={() => setViewing(i)}
                          aria-label={`Open screenshot ${i + 1} of ${d.images.length}`}
                        >
                          <img src={`/api/feedback/${d.id}/images/${s.n}`} alt="" loading="lazy" />
                        </button>
                      ))}
                    </div>
                    <p className="note">
                      Screenshots are removed 90 days after this report is closed. The words and details stay.
                    </p>
                  </>
                )}
              </section>
            )}
          </div>
          <div className="fb-right">
            <section className="card" aria-label="Status">
              <h2 className="h">Status</h2>
              <div className="seg fb-status" role="group" aria-label="Status">
                {CHOICES.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    aria-pressed={asking ? c.value === "fixed" : d.status === c.value}
                    onClick={() => choose(c.value)}
                  >
                    {c.value === "fixed" && d.status === "fixed" && !asking
                      ? `Fixed in ${d.fixedIn}`
                      : c.label}
                  </button>
                ))}
              </div>
              {asking && (
                <form
                  className="fb-version fb-rise"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void patch({ status: "fixed", fixedIn: version.trim() }).then(
                      (ok) => ok && setAsking(false),
                    );
                  }}
                >
                  <label htmlFor="fix-v">Fixed in which release?</label>
                  <div>
                    <input
                      id="fix-v"
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                      inputMode="decimal"
                      autoComplete="off"
                    />
                    <button type="submit" className="btn primary">
                      Mark fixed
                    </button>
                  </div>
                  <span className="note">
                    {d.latestRelease ? `The latest release is ${d.latestRelease}. ` : ""}Type the next one if
                    the fix ships later.
                  </span>
                </form>
              )}
              {problem && (
                <p role="alert" className="fb-problem">
                  {problem}
                </p>
              )}
              {!asking && <p className="note">{historyLine}</p>}
            </section>
            <section className="card" aria-label="Details">
              <h2 className="h">Details</h2>
              <dl className="fb-facts">
                <div>
                  <dt>Client</dt>
                  <dd>
                    <Link href={`/clients/${d.client.id}`}>{d.client.name}</Link>
                  </dd>
                </div>
                <div>
                  <dt>Reporter</dt>
                  <dd>
                    {d.reporter.name} · {d.reporter.role}
                  </dd>
                </div>
                <div className="wide">
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${d.reporter.email}`}>{d.reporter.email}</a>
                  </dd>
                </div>
                <div>
                  <dt>Page</dt>
                  <dd className="mono">{d.page}</dd>
                </div>
                <div>
                  <dt>LUME version</dt>
                  <dd>
                    {d.appVersion}{" "}
                    {isBehind(d.clientVersion ?? d.appVersion, d.latestRelease) && (
                      <span className="pill fb-behind">behind</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Browser</dt>
                  <dd title={d.browser}>{browserName(d.browser)}</dd>
                </div>
                <div>
                  <dt>Screen</dt>
                  <dd>{d.screen}</dd>
                </div>
                <div>
                  <dt>Theme</dt>
                  <dd>{d.theme === "obsidian" ? "Obsidian" : "Porcelain"}</dd>
                </div>
                <div>
                  <dt>Received</dt>
                  <dd>{when(d.receivedAt)}</dd>
                </div>
              </dl>
            </section>
            <section className="card" aria-label="Your note">
              <div className="fb-note-head">
                <label className="h" htmlFor="fb-note">
                  Your note
                </label>
                <span className="fb-saved" aria-live="polite">
                  {saved ? "Saved" : ""}
                </span>
              </div>
              <textarea
                id="fb-note"
                className="fb-note"
                placeholder="Only you see this."
                maxLength={2000}
                value={d.note}
                onChange={(e) => onNote(e.target.value)}
              />
            </section>
          </div>
        </div>
      </div>
      {viewing !== null && d.images.length > 0 && (
        <ShotViewer
          id={d.id}
          shots={d.images}
          start={viewing}
          label={label}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}
