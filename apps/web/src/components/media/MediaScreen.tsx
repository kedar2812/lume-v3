"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { filesClient, type LibraryFile } from "@/lib/files/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { MediaEmpty } from "./MediaEmpty";
import { MediaGuide } from "./MediaGuide";
import { MediaTile } from "./MediaTile";
import { UploadTray } from "./UploadTray";
import { useUploads, type Upload } from "./useUploads";
import { Viewer } from "./viewer/Viewer";
import s from "./media.module.css";

/** What WhatsApp takes (the server reads the bytes either way). */
export const ACCEPT =
  "image/jpeg,image/png,video/mp4,video/3gpp,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt";

type Filter = "all" | "photos" | "videos" | "docs";
const FILTERS: { id: Filter; label: string; has(f: LibraryFile): boolean }[] = [
  { id: "all", label: "All", has: () => true },
  { id: "photos", label: "Photos", has: (f) => f.viewAs === "image" },
  { id: "videos", label: "Videos", has: (f) => f.viewAs === "video" },
  { id: "docs", label: "Documents", has: (f) => ["pdf", "office", "sheet", "text"].includes(f.viewAs) },
];
/** Newest first: what was just added is where the eye already is. */
const newestFirst = (a: LibraryFile, b: LibraryFile) =>
  b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
/** How often the page looks again while a thumbnail is being made, and for how long at most. */
const POLL_MS = 3000;
const POLL_FOR_MS = 5 * 60_000;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Media (plan 2026-10-20-media-tab, Task 6; canvas Main, Dark, Drop, Empty, Phone): the business's files, each shown
 * by its content. Everyone who may use templates opens them; admins add them by dropping files anywhere on the page.
 */
export function MediaScreen({
  initial,
  canManage,
  guideSeen,
  onOpen,
}: {
  initial: LibraryFile[];
  canManage: boolean;
  guideSeen: boolean;
  /** Opening a file; the screen's own viewer when not given. */
  onOpen?(id: string): void;
}) {
  const reduce = !!useReducedMotion();
  const [files, setFiles] = useState(() => [...initial].sort(newestFirst));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [guide, setGuide] = useState(!guideSeen);
  const [dragging, setDragging] = useState<number | null>(null);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const put = useCallback(
    (f: LibraryFile) => setFiles((xs) => [f, ...xs.filter((x) => x.id !== f.id)].sort(newestFirst)),
    [],
  );
  const { uploads, add, dismiss } = useUploads(put);

  // While a thumbnail is being made, look again every few seconds; stop when none is, or after five minutes.
  const waiting = files.some((f) => f.preview === "pending");
  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + POLL_FOR_MS;
    const t = setInterval(() => {
      if (Date.now() > until) return clearInterval(t);
      void filesClient.list().then((r) => r.ok && setFiles([...r.data.files].sort(newestFirst)));
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting]);

  // Nothing dropped outside the page may open in the browser's own tab instead of LUME.
  useEffect(() => {
    const stop = (e: globalThis.DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((c) => [c.id, files.filter(c.has).length])), [files]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const has = FILTERS.find((c) => c.id === filter)!.has;
    return files.filter((f) => has(f) && (!q || f.name.toLowerCase().includes(q)));
  }, [files, filter, query]);
  const going = uploads.filter((u) => u.state === "waiting" || u.state === "uploading");

  const [openId, setOpenId] = useState<string | null>(null);
  const open = (id: string) => (onOpen ? onOpen(id) : setOpenId(id));
  const closeViewer = useCallback((id: string) => {
    setOpenId(null);
    // Back to the tile of the file it closed on, once the viewer has gone.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-viewer-origin="${CSS.escape(id)}"]`)?.focus(),
    );
  }, []);
  const archived = useCallback((id: string) => setFiles((xs) => xs.filter((x) => x.id !== id)), []);
  const putAway = () => {
    setGuide(false);
    void filesClient.putAwayGuide();
  };
  const choose = () => input.current?.click();

  const drag = canManage
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current++;
          setDragging(e.dataTransfer?.items?.length ?? 1);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setDragging(null);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          depth.current = 0;
          setDragging(null);
          add(Array.from(e.dataTransfer?.files ?? []));
        },
      }
    : {};

  const empty = files.length === 0 && uploads.length === 0;

  return (
    <section className={s.page} aria-label="Media" data-dragging={dragging !== null || undefined} {...drag}>
      {canManage && (
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className={s.srOnly}
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      )}
      {empty ? (
        <MediaEmpty canManage={canManage} onAdd={choose} />
      ) : (
        <>
          <header className={s.head}>
            <div className={s.title}>
              <h1>Media</h1>
              <p>Brochures, price lists, photos and videos. Add them once, then send them from any lead&apos;s WhatsApp.</p>
            </div>
            {canManage && (
              <button type="button" className={`${s.primary} ${s.addTop}`} onClick={choose}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add media
              </button>
            )}
          </header>

          <AnimatePresence initial={false}>
            {guide && <MediaGuide key="guide" canManage={canManage} onDone={putAway} />}
          </AnimatePresence>

          <div className={s.bar}>
            <div className={s.chips} role="radiogroup" aria-label="Show">
              {FILTERS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={filter === c.id}
                  className={s.chip}
                  onClick={() => setFilter(c.id)}
                >
                  {filter === c.id && (
                    <motion.span
                      layoutId="media-chip"
                      className={s.chipOn}
                      transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
                      aria-hidden
                    />
                  )}
                  <span className={s.chipLabel}>{c.label}</span>
                  <span className={s.count}>{counts[c.id]}</span>
                </button>
              ))}
            </div>
            <label className={s.search}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="search"
                aria-label="Search media"
                placeholder="Search media"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>

          {shown.length === 0 && going.length === 0 ? (
            <p className={s.none}>
              {query.trim()
                ? `Nothing in Media matches “${query.trim()}”.`
                : "Nothing of this kind yet. Add one, or choose All."}
            </p>
          ) : (
            <ul className={s.grid} aria-label="Your media">
              <AnimatePresence initial={false} mode="popLayout">
                {going.map((u) => (
                  <motion.li
                    key={u.key}
                    layout={reduce ? false : "position"}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={toMotion(SPRINGS.soft)}
                  >
                    <UploadTile upload={u} />
                  </motion.li>
                ))}
                {shown.map((f) => (
                  <motion.li
                    key={f.id}
                    layout={reduce ? false : "position"}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                    transition={toMotion(SPRINGS.default)}
                  >
                    <MediaTile file={f} onOpen={open} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}

          {canManage && (
            <div className={s.phoneAdd}>
              <button type="button" className={s.primary} onClick={choose}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add from this phone
              </button>
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {dragging !== null && (
          <motion.div
            className={s.drop}
            aria-hidden
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.01 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            <span className={s.dropIcon}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
              </svg>
            </span>
            <b>{dragging > 1 ? `Drop to add ${dragging} files to Media` : "Drop to add it to Media"}</b>
            <span>Photos, videos and documents. Each one is kept once and sent as the real file.</span>
          </motion.div>
        )}
      </AnimatePresence>

      <UploadTray uploads={uploads} onDismiss={dismiss} />

      {openId && (
        <Viewer
          files={shown}
          openId={openId}
          canManage={canManage}
          onClose={closeViewer}
          onChange={put}
          onArchived={archived}
        />
      )}
    </section>
  );
}

/** A file on its way up (canvas Main): its ring filling where its tile will be. */
function UploadTile({ upload: u }: { upload: Upload }) {
  return (
    <div className={s.tile} data-uploading>
      <span className={s.thumb} data-page>
        <span className={s.uploadVeil}>
          <ProgressRing value={u.share} size={44} label={`Uploading ${u.name}`} color="var(--accent)" />
          <span>{u.state === "waiting" ? "Waiting" : `Uploading ${Math.round(u.share * 100)}%`}</span>
        </span>
      </span>
      <span className={s.cap}>
        <span className={s.name}>{u.name}</span>
        <span className={s.meta}>On its way</span>
      </span>
    </div>
  );
}
