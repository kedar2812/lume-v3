"use client";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FEEDBACK_LIMITS as L, pagePath, type FeedbackKind } from "@lume/core/shared";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { feedbackClient } from "@/lib/feedback/client";
import { canCapture, captureTab, encodeShot, loadImage, type Prepared } from "@/lib/feedback/encode";
import { notSent, screenOf, themeOf, type Rect } from "@/lib/feedback/shots";
import { BlurEditor } from "./BlurEditor";
import s from "./send-feedback.module.css";

/**
 * A screenshot in the sheet. It joins the moment it's chosen, and while it's being made ready (`pending`, the
 * number of the encode under way) nothing can be sent: the picture that goes is always the last one asked for,
 * blur and all.
 */
type Shot = {
  id: number;
  source: ImageBitmap;
  rects: Rect[];
  prepared: Prepared | null;
  refused: boolean;
  pending: number | null;
};
const KINDS: { value: FeedbackKind; label: string; dot: string }[] = [
  { value: "bug", label: "Something's broken", dot: "var(--danger)" },
  { value: "idea", label: "An idea", dot: "var(--accent)" },
  { value: "confusing", label: "Something's confusing", dot: "var(--warn)" },
];

/**
 * Send feedback (spec 2026-10-16 §1.2; canvas boards 1–5): what happened, a kind, up to five screenshots (blurred
 * where private), and one plain line saying where it goes. It closes only once the report reached LUME's team; when
 * it didn't, everything stays, with one line saying why.
 */
export function FeedbackSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const path = usePathname();
  const { toast } = useToast();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [text, setText] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [blurring, setBlurring] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);
  const inFlight = useRef(false);
  const seq = useRef(0);
  const urls = useRef(new Set<string>());
  const textId = useId();
  // The page it was opened from, without what was searched.
  const [page] = useState(() => pagePath(path ?? "/"));

  // Thumbnails are object URLs: let them go with the sheet.
  useEffect(() => {
    const live = urls.current;
    return () => {
      for (const u of live) URL.revokeObjectURL(u);
      live.clear();
    };
  }, []);
  if (!open || hidden) return null;

  const keep = (p: Prepared | null) => {
    if (p) urls.current.add(p.url);
    return p;
  };
  const drop = (p: Prepared | null) => {
    if (!p) return;
    URL.revokeObjectURL(p.url);
    urls.current.delete(p.url);
  };
  const empty = text.trim() === "";
  const busy = shots.some((x) => x.pending !== null);
  const hasContent = !empty || shots.length > 0;
  const close = () => {
    for (const sh of shots) drop(sh.prepared);
    onClose();
  };
  const askClose = () => {
    if (sending) return;
    if (hasContent) setConfirm(true);
    else close();
  };

  // Make a shot's picture afresh (with these blur boxes); only the encode asked for last is kept.
  const prepare = async (id: number, source: ImageBitmap, rects: Rect[]) => {
    const run = ++seq.current;
    setShots((all) => all.map((x) => (x.id === id ? { ...x, rects, pending: run } : x)));
    const prepared = keep(await encodeShot(source, rects).catch(() => null));
    setShots((all) => {
      const sh = all.find((x) => x.id === id);
      if (!sh || sh.pending !== run) {
        drop(prepared); // removed meanwhile, or asked for again
        return all;
      }
      drop(sh.prepared);
      return all.map((x) => (x.id === id ? { ...x, prepared, refused: !prepared, pending: null } : x));
    });
  };
  const addSource = async (source: ImageBitmap) => {
    const id = ++seq.current;
    // Five at most: one that doesn't fit never joins, and its picture is let go when it's made.
    setShots((all) =>
      all.length >= L.images
        ? all
        : [...all, { id, source, rects: [], prepared: null, refused: false, pending: id }],
    );
    await prepare(id, source, []);
  };
  const add = async (files: Blob[]) => {
    for (const file of files.slice(0, Math.max(0, L.images - shots.length))) {
      const source = await loadImage(file);
      if (source) await addSource(source);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void add(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void add([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
  };
  const capture = async () => {
    const shot = await captureTab(
      () =>
        new Promise<void>((r) => {
          setHidden(true);
          requestAnimationFrame(() => r());
        }),
      () => setHidden(false),
    );
    if (shot) await addSource(shot);
  };
  const remove = (id: number) =>
    setShots((all) => {
      drop(all.find((x) => x.id === id)?.prepared ?? null);
      return all.filter((x) => x.id !== id);
    });
  const blurDone = async (id: number, rects: Rect[]) => {
    setBlurring(null);
    const sh = shots.find((x) => x.id === id);
    if (sh) await prepare(id, sh.source, rects);
  };

  const send = async () => {
    if (empty || inFlight.current || busy || shots.some((x) => !x.prepared)) return;
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    const r = await feedbackClient.send({
      kind,
      text,
      page,
      theme: themeOf(document, window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false),
      screen: screenOf(window).slice(0, L.screen),
      images: shots.map((x) => ({ type: x.prepared!.type, data: x.prepared!.data })),
    });
    inFlight.current = false;
    setSending(false);
    if (r.ok) {
      // No sound: sending a report isn't an achievement.
      toast({ tone: "ok", title: "Sent. Thank you.", detail: "LUME's team reads every report." });
      close();
      return;
    }
    const why = notSent(r);
    setProblem(why.text);
    setFailed(true);
    if (why.imageIndex !== undefined)
      setShots((all) => all.map((x, i) => (i === why.imageIndex ? { ...x, refused: true } : x)));
  };

  const full = shots.length >= L.images;
  const blurShot = blurring === null ? null : shots.find((x) => x.id === blurring);
  return (
    <>
      <Dialog
        label="Send feedback"
        onClose={askClose}
        width={600}
        className={s.panel}
        layerClassName={s.layer}
      >
        <div className={s.sheet} onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <header className={s.head}>
            <h2>Send feedback</h2>
            <button type="button" className={s.x} aria-label="Close" onClick={askClose}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </header>
          <div className={s.body}>
            <div className={s.kinds} role="radiogroup" aria-label="Kind">
              {KINDS.map((k) => (
                <label key={k.value} className={s.kind} data-on={kind === k.value || undefined}>
                  <input
                    type="radio"
                    name="feedback-kind"
                    value={k.value}
                    checked={kind === k.value}
                    onChange={() => setKind(k.value)}
                  />
                  <i style={{ background: k.dot }} aria-hidden />
                  {k.label}
                </label>
              ))}
            </div>
            <div className={s.field}>
              <label htmlFor={textId}>What happened?</label>
              <textarea
                id={textId}
                value={text}
                maxLength={L.text}
                placeholder="What you did, what you expected, what LUME did instead."
                onChange={(e) => {
                  setText(e.target.value);
                  setProblem(null);
                }}
              />
              {text.length >= L.textCountFrom && (
                <span className={s.count}>
                  {text.length.toLocaleString("en-IN")} of {L.text.toLocaleString("en-IN")}
                </span>
              )}
              {problem && (
                <p role="alert" className={s.problem}>
                  {problem}
                </p>
              )}
            </div>
            <div className={s.field}>
              <div className={s.shotsHead}>
                <span className={s.label}>Screenshots</span>
                <span className={s.muted}>
                  {shots.length} of {L.images}
                </span>
              </div>
              <div className={s.shots}>
                {shots.map((sh, i) => (
                  <div key={sh.id} className={s.shotCell}>
                    <div className={s.shot} data-refused={sh.refused || undefined}>
                      {/* A local blob of the person's own screenshot. */}
                      {sh.prepared && <img src={sh.prepared.url} alt={`Screenshot ${i + 1}`} />}
                      {!sh.prepared && sh.pending !== null && (
                        <span className={s.preparing}>Getting it ready…</span>
                      )}
                      {sh.refused && (
                        <span className={s.refused}>LUME can&apos;t send this one. Choose it again</span>
                      )}
                      <button
                        type="button"
                        className={s.remove}
                        aria-label={`Remove screenshot ${i + 1}`}
                        onClick={() => remove(sh.id)}
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          aria-hidden
                        >
                          <path d="m4 4 8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    </div>
                    {sh.prepared && (
                      <button
                        type="button"
                        className={s.chip}
                        onClick={() => setBlurring(sh.id)}
                        aria-label={`Blur screenshot ${i + 1}`}
                        disabled={sh.pending !== null}
                      >
                        {sh.pending !== null ? "Blurring…" : sh.rects.length ? "Blurred" : "Blur"}
                      </button>
                    )}
                  </div>
                ))}
                {!full && <div className={s.drop}>Paste, drop, or choose below</div>}
              </div>
              <div className={s.row}>
                <label className={s.pick} data-disabled={full || undefined}>
                  Choose images
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    aria-label="Choose images"
                    disabled={full}
                    onChange={(e) => {
                      void add([...(e.target.files ?? [])]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {canCapture() && (
                  <Button size="sm" onClick={() => void capture()} disabled={full}>
                    Capture this screen
                  </Button>
                )}
              </div>
            </div>
            <p className={s.plain}>
              This goes to the team that makes LUME, with your name, email and role, the page you were on and
              your LUME version. Screenshots show whatever is on them, so blur anything private first.
            </p>
          </div>
          {confirm && (
            <div className={s.discard}>
              <span>Discard this report?</span>
              <Button variant="danger" size="sm" onClick={close}>
                Discard
              </Button>
              <Button size="sm" onClick={() => setConfirm(false)}>
                Keep writing
              </Button>
            </div>
          )}
          <footer className={s.foot}>
            {empty && <span className={s.hint}>Tell LUME what happened</span>}
            <span className={s.grow} />
            <Button variant="ghost" onClick={askClose} disabled={sending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void send()} disabled={empty || sending || busy}>
              {sending ? "Sending…" : failed ? "Try again" : "Send"}
            </Button>
          </footer>
        </div>
      </Dialog>
      {blurShot?.prepared && (
        <BlurEditor
          url={blurShot.prepared.url}
          image={{ w: blurShot.source.width, h: blurShot.source.height }}
          initial={blurShot.rects}
          onDone={(r) => void blurDone(blurShot.id, r)}
          onCancel={() => setBlurring(null)}
        />
      )}
    </>
  );
}
