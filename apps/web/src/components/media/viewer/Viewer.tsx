"use client";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { BodyPortal } from "@/components/ui/BodyPortal";
import { useModalFocus } from "@/components/ui/useModalFocus";
import { contentUrl, filesClient, pdfUrl, type LibraryFile } from "@/lib/files/client";
import { bytesText } from "@lume/core/shared";
import { mediaMeta } from "@/lib/files/words";
import { SPRINGS, sheetDismisses, toMotion } from "@/lib/motion";
import { FileArt } from "../FileArt";
import { ImageView } from "./ImageView";
import { InfoPanel } from "./InfoPanel";
import { PdfView } from "./PdfView";
import { SheetView } from "./SheetView";
import { TextView } from "./TextView";
import { ToolbarSlot } from "./Toolbar";
import { useSwipe, type SwipeDirection } from "./useSwipe";
import { AudioView, VideoView } from "./VideoView";
import v from "./viewer.module.css";

/** How long "This is the last file" stays. */
const EDGE_MS = 2200;

/** Where a file's tile is on the page, when it's there to grow from or shrink back into. */
function originRect(id: string): DOMRect | null {
  const tile = document.querySelector<HTMLElement>(`[data-viewer-origin="${CSS.escape(id)}"]`);
  const thumb = tile?.querySelector<HTMLElement>("[data-kind]") ?? tile;
  const r = thumb?.getBoundingClientRect();
  if (!r || r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > window.innerHeight) return null;
  return r;
}
/** The transform that puts `el` where `r` is. */
function towards(el: HTMLElement, r: DOMRect) {
  const to = el.getBoundingClientRect();
  if (to.width < 1 || to.height < 1) return null;
  return {
    x: r.left + r.width / 2 - (to.left + to.width / 2),
    y: r.top + r.height / 2 - (to.top + to.height / 2),
    scale: Math.min(r.width / to.width, r.height / to.height),
  };
}

function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const q = window.matchMedia?.("(max-width: 860px)");
    if (!q) return;
    const on = () => setPhone(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return phone;
}

const headerMeta = (f: LibraryFile) =>
  f.viewAs === "image" && f.width && f.height
    ? `Photo · ${f.width} × ${f.height} · ${bytesText(f.size)}`
    : mediaMeta(f);

/**
 * LUME's own viewer (plan 2026-10-20-media-tab, Task 7; canvas Viewer, Detail, Video, Office, PhoneSheet): every kind
 * of file opens here, over the whole window, never in another tab. It grows out of the file's tile and shrinks back
 * into it; Left and Right (or a swipe) move through the page's files in its order; Info says where the file goes and
 * holds its link, name and archive. Escape closes it.
 */
export function Viewer({
  files,
  openId,
  canManage,
  onClose,
  onChange,
  onArchived,
}: {
  files: LibraryFile[];
  openId: string;
  canManage: boolean;
  /** Closed, on this file: its tile gets the focus back. */
  onClose(id: string): void;
  onChange(f: LibraryFile): void;
  onArchived(id: string): void;
}) {
  const reduce = !!useReducedMotion();
  const phone = useIsPhone();
  const { toast } = useToast();
  const [id, setId] = useState(openId);
  const [dir, setDir] = useState<1 | -1>(1);
  const [info, setInfo] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [edge, setEdge] = useState("");
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const zoom = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const edgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const index = files.findIndex((f) => f.id === id);
  const f = index >= 0 ? files[index]! : null;

  const close = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    const r = originRect(id);
    const el = zoom.current;
    const t = r && el && !reduce ? towards(el, r) : null;
    if (t && el && root.current) {
      await Promise.all([
        animate(el, { x: t.x, y: t.y, scale: t.scale, opacity: 0.4 }, toMotion(SPRINGS.default)),
        animate(root.current, { opacity: 0 }, { duration: 0.26, ease: "easeOut" }),
      ]);
    } else if (root.current && !reduce && el) {
      await animate(root.current, { opacity: 0 }, { duration: 0.18, ease: "easeOut" });
    }
    onClose(id);
  }, [id, onClose, reduce]);

  const modal = useModalFocus(root, () => void close());

  // Opening grows the file out of its tile; the dark ground fades in behind it.
  useLayoutEffect(() => {
    const el = zoom.current;
    const r = originRect(openId);
    const t = r && el && !reduce ? towards(el, r) : null;
    if (root.current)
      void animate(root.current, { opacity: [0, 1] }, { duration: reduce ? 0.16 : 0.22, ease: "easeOut" });
    if (t && el)
      void animate(
        el,
        { x: [t.x, 0], y: [t.y, 0], scale: [t.scale, 1], opacity: [0.5, 1] },
        toMotion(SPRINGS.default),
      );
    // Only when it opens: moving between files has its own motion.
  }, []);

  useEffect(() => () => void (edgeTimer.current && clearTimeout(edgeTimer.current)), []);
  // The file went (archived from somewhere else): nothing to show.
  useEffect(() => {
    if (!f && !closing.current) onClose(id);
  }, [f, id, onClose]);

  const canGo = (d: SwipeDirection) => (d === "next" ? index < files.length - 1 : index > 0);
  const move = (d: SwipeDirection) => {
    if (!canGo(d)) {
      setEdge(d === "next" ? "This is the last file." : "This is the first file.");
      if (edgeTimer.current) clearTimeout(edgeTimer.current);
      edgeTimer.current = setTimeout(() => setEdge(""), EDGE_MS);
      return;
    }
    const to = files[index + (d === "next" ? 1 : -1)]!;
    setDir(d === "next" ? 1 : -1);
    setZoomed(false);
    setRenaming(false);
    setId(to.id);
  };
  const jump = (to: string) => {
    const i = files.findIndex((x) => x.id === to);
    if (i < 0 || i === index) return;
    setDir(i > index ? 1 : -1);
    setZoomed(false);
    setRenaming(false);
    setId(to);
  };
  const swipe = useSwipe({ enabled: !zoomed && !renaming, canGo, onSwipe: move });

  // The viewer's keys, from anywhere on the page while it's open: a control that held the focus can go away (Find
  // closing, a file archived) and drop it on the page, and the keys must keep working. Inside the viewer, a control
  // that uses the arrows itself (a slider, a search box) keeps them: its own handler stops them reaching here.
  const keyActions = useRef<(e: globalThis.KeyboardEvent) => void>(() => undefined);
  keyActions.current = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    if (e.key === "ArrowRight") return void (e.preventDefault(), move("next"));
    if (e.key === "ArrowLeft") return void (e.preventDefault(), move("previous"));
    if (e.key === "i" || e.key === "I") return void (e.preventDefault(), setInfo((o) => !o));
    // Focus outside the viewer (dropped on the page): Escape still closes it.
    if (e.key === "Escape" && !root.current?.contains(t)) return void (e.preventDefault(), void close());
  };
  useEffect(() => {
    const on = (e: globalThis.KeyboardEvent) => keyActions.current(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  const keys = (e: KeyboardEvent<HTMLDivElement>) => modal.onKeyDown(e);

  const archive = async () => {
    if (!f) return;
    const r = await filesClient.archive(f.id);
    if (!r.ok) return toast({ tone: "danger", title: `${f.name} couldn't be archived`, detail: r.message });
    const gone = f;
    const next = files[index + 1] ?? files[index - 1] ?? null;
    if (next) {
      setDir(files[index + 1] ? 1 : -1);
      setId(next.id);
    }
    onArchived(gone.id);
    toast({
      tone: "ok",
      title: `${gone.name} archived`,
      detail: "Messages that already sent it keep it.",
      action: {
        label: "Undo",
        onClick: () =>
          void filesClient.restore(gone.id).then((x) => {
            if (x.ok) onChange(x.data.file);
            else toast({ tone: "danger", title: `${gone.name} couldn't be put back`, detail: x.message });
          }),
      },
    });
    if (!next) onClose(gone.id);
  };

  if (!f) return null;
  const strip = files.length > 1 && (f.viewAs === "image" || f.viewAs === "video" || f.viewAs === "audio");

  const infoPanel = (
    <InfoPanel
      file={f}
      canManage={canManage}
      onChange={onChange}
      onRename={() => setRenaming(true)}
      onArchive={() => void archive()}
    />
  );

  return (
    <BodyPortal>
      <div
        ref={root}
        className={v.viewer}
        role="dialog"
        aria-modal="true"
        aria-label={f.name}
        tabIndex={-1}
        onKeyDown={keys}
      >
        <header className={v.head}>
          <button
            type="button"
            className={v.back}
            aria-label="Back to Media (Esc)"
            onClick={() => void close()}
          >
            <ChevronLeft size={18} aria-hidden />
            <span>Media</span>
          </button>
          <div className={v.titles}>
            {renaming ? (
              <RenameBox file={f} onDone={(nf) => (nf && onChange(nf), setRenaming(false))} />
            ) : (
              <b className={v.fileName}>{f.name}</b>
            )}
            <span className={v.fileMeta}>{headerMeta(f)}</span>
          </div>
          <span className={v.grow} />
          <div ref={setSlot} className={v.tools} />
          <button
            type="button"
            className={v.tb}
            // The word goes on a phone; the name stays.
            aria-label="Info"
            data-on={info || undefined}
            aria-pressed={info}
            onClick={() => setInfo((o) => !o)}
          >
            <Info size={16} aria-hidden />
            <span className={v.tbWord}>Info</span>
          </button>
        </header>

        <div className={v.body}>
          <div className={v.stageArea} {...swipe.bind}>
            <button
              type="button"
              className={v.nav}
              data-side="previous"
              aria-label="Previous file"
              disabled={index === 0}
              onClick={() => move("previous")}
            >
              <ChevronLeft size={22} aria-hidden />
            </button>
            <div ref={zoom} className={v.zoom}>
              <motion.div className={v.swipe} style={{ x: swipe.x }}>
                <AnimatePresence initial={false} custom={dir} mode="popLayout">
                  <motion.div
                    key={f.id}
                    className={v.content}
                    custom={dir}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, x: dir * 56, scale: 0.98 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, x: dir * -56, scale: 0.98 }}
                    transition={toMotion(SPRINGS.default)}
                  >
                    <ToolbarSlot.Provider value={slot}>
                      <Content file={f} canManage={canManage} onChange={onChange} onZoomed={setZoomed} />
                    </ToolbarSlot.Provider>
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            </div>
            <button
              type="button"
              className={v.nav}
              data-side="next"
              aria-label="Next file"
              disabled={index === files.length - 1}
              onClick={() => move("next")}
            >
              <ChevronRight size={22} aria-hidden />
            </button>
          </div>

          <AnimatePresence initial={false}>
            {info &&
              (phone ? (
                <PhoneSheet key="sheet" onClose={() => setInfo(false)} reduce={reduce}>
                  {infoPanel}
                </PhoneSheet>
              ) : (
                <motion.aside
                  key="aside"
                  className={v.aside}
                  aria-label="Info"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, x: 28 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, x: 28 }}
                  transition={toMotion(SPRINGS.drawer)}
                >
                  {infoPanel}
                </motion.aside>
              ))}
          </AnimatePresence>
        </div>

        {strip && (
          <nav className={v.strip} aria-label="Other media">
            {files.map((x) => (
              <StripItem key={x.id} file={x} current={x.id === f.id} onPick={() => jump(x.id)} />
            ))}
          </nav>
        )}

        <div className={v.hud} role="status" data-on={edge ? true : undefined}>
          {edge}
        </div>
      </div>
    </BodyPortal>
  );
}

/** What each kind of file opens as. */
function Content({
  file: f,
  canManage,
  onChange,
  onZoomed,
}: {
  file: LibraryFile;
  canManage: boolean;
  onChange(f: LibraryFile): void;
  onZoomed(z: boolean): void;
}) {
  switch (f.viewAs) {
    case "image":
      return <ImageView file={f} onZoomed={onZoomed} />;
    case "video":
      return <VideoView file={f} />;
    case "audio":
      return <AudioView file={f} />;
    case "pdf":
      return <PdfView src={contentUrl(f.id)} pages={f.pages} name={f.name} />;
    case "sheet":
      return <SheetView src={contentUrl(f.id)} name={f.name} />;
    case "text":
      return <TextView file={f} />;
    case "office":
      return f.preview === "ready" ? (
        <PdfView src={pdfUrl(f.id)} pages={f.pages} name={f.name} />
      ) : (
        <OfficeWaiting file={f} canManage={canManage} onChange={onChange} />
      );
  }
}

/** A Word or PowerPoint file whose pages aren't here: why, in plain words, and what can still be done. */
function OfficeWaiting({
  file: f,
  canManage,
  onChange,
}: {
  file: LibraryFile;
  canManage: boolean;
  onChange(f: LibraryFile): void;
}) {
  const [busy, setBusy] = useState(false);
  const words =
    f.preview === "pending"
      ? "LUME is making this file's pages. They'll be here in a moment."
      : f.preview === "failed"
        ? "LUME couldn't show this file's pages. It still sends as it is, from any lead's WhatsApp."
        : "This server can't show Word and PowerPoint files yet. You can still send this one from any lead's WhatsApp, as the real file.";
  return (
    <div className={v.waiting}>
      <span className={v.waitArt} data-pending={f.preview === "pending" || undefined}>
        <FileArt file={f} />
      </span>
      <p>{words}</p>
      {f.preview === "failed" && canManage && (
        <button
          type="button"
          className={v.tbLight}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void filesClient.retryPreview(f.id).then((r) => {
              setBusy(false);
              if (r.ok) onChange(r.data.file);
            });
          }}
        >
          {busy ? "Trying…" : "Try again"}
        </button>
      )}
    </div>
  );
}

/** The file's name, changed in place: Enter keeps the change, Escape the name it had. */
function RenameBox({ file: f, onDone }: { file: LibraryFile; onDone(f: LibraryFile | null): void }) {
  const [draft, setDraft] = useState(f.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cancelled = useRef(false);
  const save = async () => {
    const name = draft.trim();
    if (!name || name === f.name) return onDone(null);
    if (saving) return;
    setSaving(true);
    const r = await filesClient.rename(f.id, name);
    setSaving(false);
    if (!r.ok) return setProblem(r.message);
    onDone(r.data.file);
  };
  return (
    <span className={v.rename}>
      <input
        aria-label={`Name of ${f.name}`}
        value={draft}
        maxLength={120}
        autoFocus
        readOnly={saving}
        onFocus={(e) => {
          // The name, without its extension, is what's usually changed.
          const dot = e.currentTarget.value.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setProblem(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            onDone(null);
          }
        }}
        onBlur={() => {
          if (!cancelled.current && !problem) void save();
        }}
      />
      {problem && (
        <span role="alert" className={v.renameProblem}>
          {problem}
        </span>
      )}
    </span>
  );
}

/** One file in the strip under a photo or video (canvas Detail). */
function StripItem({ file: f, current, onPick }: { file: LibraryFile; current: boolean; onPick(): void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduce = !!useReducedMotion();
  useEffect(() => {
    if (current)
      ref.current?.scrollIntoView?.({
        inline: "center",
        block: "nearest",
        behavior: reduce ? "auto" : "smooth",
      });
  }, [current, reduce]);
  return (
    <button
      ref={ref}
      type="button"
      className={v.stripItem}
      aria-label={f.name}
      aria-current={current ? "true" : undefined}
      onClick={onPick}
    >
      {f.preview === "ready" && f.thumbUrl ? (
        <img src={f.thumbUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <FileArt file={f} size="small" />
      )}
    </button>
  );
}

/** Info on a phone (canvas PhoneSheet): a sheet from the bottom, dragged down or tapped away to close. */
function PhoneSheet({
  children,
  onClose,
  reduce,
}: {
  children: ReactNode;
  onClose(): void;
  reduce: boolean;
}) {
  return (
    <>
      <motion.div
        className={v.sheetVeil}
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        className={v.infoSheet}
        aria-label="Info"
        initial={reduce ? { opacity: 0 } : { y: "100%" }}
        animate={reduce ? { opacity: 1 } : { y: 0 }}
        exit={reduce ? { opacity: 0 } : { y: "100%" }}
        transition={toMotion(SPRINGS.drawer)}
        drag={reduce ? false : "y"}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.04, bottom: 1 }}
        onDragEnd={(_, i) => sheetDismisses(i.offset.y, i.velocity.y) && onClose()}
      >
        <span className={v.grabber} aria-hidden />
        {children}
      </motion.aside>
    </>
  );
}
