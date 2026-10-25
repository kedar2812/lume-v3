"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ChevronUp, Minus, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { loadPdf, type PdfDoc, type PdfTextItem } from "./pdf";
import { findIn, indexPage, type FoundPart, type PageIndex } from "./pdf-find";
import { Toolbar } from "./Toolbar";
import v from "./viewer.module.css";

/** How wide a page is shown when it's fitted: wide enough to read, never a wall of text. */
const FIT_MAX = 900;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const PAD = 56;

type Match = { page: number; parts: FoundPart[] };
/** Whether Find can read this file: every page has text, some do, none do, or its text couldn't be read at all. */
type Readable = "all" | "some" | "none" | "failed";
const isText = (i: PdfTextItem | { type: string }): i is PdfTextItem => "str" in i;

/**
 * A PDF in LUME's viewer (plan 2026-10-20-media-tab, Task 8; canvas Viewer), and Word and PowerPoint files through
 * the PDF the server made of them: pages one under another, drawn on canvases only near the view (a 400-page file
 * stays smooth and light), a strip of pages beside them, zoom, and Find in it with each match highlighted.
 */
export function PdfView({ src, pages: known, name }: { src: string; pages: number | null; name: string }) {
  const reduce = !!useReducedMotion();
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [base, setBase] = useState<{ w: number; h: number }>({ w: 612, h: 792 });
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [finding, setFinding] = useState(false);
  const findButton = useRef<HTMLButtonElement>(null);
  /** Find put away: its words cleared, and the focus back on its button (never dropped on the page). */
  const closeFind = () => {
    setFinding(false);
    setQuery("");
    setMatches(null);
    findButton.current?.focus();
  };
  /** The file's text, read once when Find first opens: how far it's got, and what it found it can read. */
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [readable, setReadable] = useState<Readable | null>(null);
  const [blank, setBlank] = useState(0);
  const pageText = useRef(new Map<number, PageIndex>());
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [at, setAt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const texts = useRef(new Map<number, PdfTextItem[]>());
  const count = doc?.numPages ?? known ?? 0;

  useEffect(() => {
    let live = true;
    let loaded: PdfDoc | null = null;
    setDoc(null);
    setFailed(false);
    texts.current.clear();
    pageText.current.clear();
    setReadable(null);
    setReading(null);
    loadPdf(src).then(
      async (d) => {
        if (!live) return void d.destroy();
        loaded = d;
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (!live) return;
        setBase({ w: vp.width, h: vp.height });
        setDoc(d);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      void loaded?.destroy();
    };
  }, [src]);

  // The fitted width follows the window.
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  const fitScale = Math.max(0.2, Math.min(FIT_MAX, width - PAD) / base.w);
  const scale = zoom === "fit" ? fitScale : zoom;
  const current = visible.size ? Math.min(...visible) : 1;

  // Which pages are in view, so only they (and one either side) are drawn.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !doc) return;
    const io = new IntersectionObserver(
      (entries) =>
        setVisible((was) => {
          const next = new Set(was);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next.size ? next : was;
        }),
      { root, threshold: 0.01 },
    );
    root.querySelectorAll("[data-page]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [doc, count]);

  const drawn = useMemo(() => {
    if (!visible.size) return new Set<number>();
    const lo = Math.max(1, Math.min(...visible) - 1);
    const hi = Math.min(count, Math.max(...visible) + 1);
    // Many pages in view (zoomed far out): the ones in view, never a long run of hidden ones.
    const out = new Set<number>();
    for (let n = lo; n <= hi; n++) if (visible.has(n) || n === lo || n === hi) out.add(n);
    return out;
  }, [visible, count]);

  const goTo = useCallback(
    (n: number) => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
      el?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
    },
    [reduce],
  );

  // Find in it: every page's text, read once when Find first opens (a page that's a picture has none). Whether the file
  // can be searched at all is known before the first word is typed.
  useEffect(() => {
    if (!doc || !finding || readable) return;
    let live = true;
    void (async () => {
      let empty = 0;
      try {
        for (let n = 1; n <= doc.numPages && live; n++) {
          setReading({ done: n - 1, total: doc.numPages });
          let items = texts.current.get(n);
          if (!items) {
            const page = await doc.getPage(n);
            items = (await page.getTextContent()).items.filter(isText);
            texts.current.set(n, items);
          }
          const indexed = indexPage(items);
          pageText.current.set(n, indexed);
          if (!indexed.text) empty++;
        }
      } catch {
        if (live) {
          setReadable("failed");
          setReading(null);
        }
        return;
      }
      if (!live) return;
      setBlank(empty);
      setReadable(empty === doc.numPages ? "none" : empty ? "some" : "all");
      setReading(null);
    })();
    return () => {
      live = false;
    };
  }, [doc, finding, readable]);

  useEffect(() => {
    if (!doc || !finding || (readable !== "all" && readable !== "some")) return;
    if (!query.trim()) return void setMatches(null);
    const t = setTimeout(() => {
      const found: Match[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = pageText.current.get(n);
        if (page) for (const parts of findIn(page, query)) found.push({ page: n, parts });
      }
      setMatches(found);
      setAt(0);
      if (found[0]) goTo(found[0].page);
    }, 120);
    return () => clearTimeout(t);
  }, [doc, finding, readable, query, goTo]);

  const step = (d: 1 | -1) => {
    if (!matches?.length) return;
    const n = (at + d + matches.length) % matches.length;
    setAt(n);
    goTo(matches[n]!.page);
  };
  const zoomBy = (d: 1 | -1) => {
    const now = scale;
    const next = d > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
    if (next) setZoom(next);
  };

  if (failed)
    return (
      <p className={v.say}>LUME couldn&apos;t read this PDF. It may be damaged or locked with a password.</p>
    );

  // Said as it is: still reading, found, or not, and how much of the file Find couldn't read when that matters.
  const unread =
    readable === "some"
      ? ` ${blank} of ${count} pages ${blank === 1 ? "is a picture" : "are pictures"} LUME can't read.`
      : "";
  const status = reading
    ? `Reading the file… ${reading.done} of ${reading.total}`
    : !query.trim()
      ? ""
      : matches === null
        ? "Looking…"
        : matches.length === 0
          ? readable === "some"
            ? `Not found.${unread}`
            : "Not in this file"
          : `${at + 1} of ${matches.length}`;
  const unavailable =
    readable === "none"
      ? "Find isn't available for this file. Its pages are pictures, with no text LUME can read."
      : readable === "failed"
        ? "Find isn't available for this file. LUME couldn't read its text."
        : null;
  const pageW = Math.round(base.w * scale);
  const pageH = Math.round(base.h * scale);

  return (
    <div className={v.pdf}>
      <Toolbar>
        <div className={v.group} role="group" aria-label="Pages">
          <button
            type="button"
            className={v.tb}
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => goTo(current - 1)}
          >
            <ChevronUp size={16} aria-hidden />
          </button>
          <span className={v.pageOf}>
            Page {current} of {count || "…"}
          </span>
          <button
            type="button"
            className={v.tb}
            aria-label="Next page"
            disabled={current >= count}
            onClick={() => goTo(current + 1)}
          >
            <ChevronDown size={16} aria-hidden />
          </button>
        </div>
        <div className={v.group} role="group" aria-label="Zoom">
          <button
            type="button"
            className={v.tb}
            aria-label="Zoom out"
            onClick={() => zoomBy(-1)}
            disabled={scale <= ZOOMS[0]! + 0.01}
          >
            <Minus size={16} aria-hidden />
          </button>
          <button type="button" className={v.zoomLabel} onClick={() => setZoom("fit")}>
            {zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`}
          </button>
          <button
            type="button"
            className={v.tb}
            aria-label="Zoom in"
            onClick={() => zoomBy(1)}
            disabled={scale >= ZOOMS.at(-1)! - 0.01}
          >
            <Plus size={16} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className={v.tb}
          // The word goes on a phone; the name stays.
          aria-label="Find in it"
          ref={findButton}
          aria-pressed={finding}
          data-on={finding || undefined}
          onClick={() => (finding ? closeFind() : setFinding(true))}
        >
          <Search size={15} aria-hidden />
          <span className={v.tbWord}>Find in it</span>
        </button>
      </Toolbar>

      <AnimatePresence initial={false}>
        {finding && (
          <motion.div
            className={v.find}
            data-unavailable={unavailable ? "" : undefined}
            // Floats over the pages from the Find button's corner, and goes back the way it came.
            style={{ transformOrigin: "100% 0%" }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
            transition={toMotion(SPRINGS.default)}
          >
            <Search size={15} aria-hidden />
            {unavailable ? (
              <p className={v.findSay} role="status">
                {unavailable}
              </p>
            ) : (
              <>
                <input
                  type="search"
                  aria-label={`Find in ${name}`}
                  placeholder="Find a word"
                  autoFocus
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setMatches(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      step(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      closeFind();
                    }
                    // Typing never moves to another file.
                    e.stopPropagation();
                  }}
                />
                <span role="status" className={v.findStatus}>
                  {status}
                </span>
                <button
                  type="button"
                  className={v.tb}
                  aria-label="Previous match"
                  disabled={!matches?.length}
                  onClick={() => step(-1)}
                >
                  <ChevronUp size={15} aria-hidden />
                </button>
                <button
                  type="button"
                  className={v.tb}
                  aria-label="Next match"
                  disabled={!matches?.length}
                  onClick={() => step(1)}
                >
                  <ChevronDown size={15} aria-hidden />
                </button>
              </>
            )}
            <button
              type="button"
              className={v.tb}
              aria-label="Close Find"
              onClick={() => {
                closeFind();
              }}
            >
              <X size={15} aria-hidden />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={v.pdfBody}>
        {doc && count > 1 && (
          <nav className={v.pageStrip} aria-label={`Pages of ${name}, small`}>
            {Array.from({ length: count }, (_, i) => (
              <PageThumb
                key={i}
                doc={doc}
                n={i + 1}
                ratio={base.h / base.w}
                current={i + 1 === current}
                onPick={() => goTo(i + 1)}
              />
            ))}
          </nav>
        )}
        <section
          ref={scroller}
          className={v.pages}
          aria-label={`Pages of ${name}`}
          aria-busy={!doc || undefined}
          // The pages scroll: the keyboard reaches them to scroll too.
          tabIndex={0}
        >
          {!doc ? (
            <div
              className={v.pageSkeleton}
              style={{ width: Math.min(FIT_MAX, width - PAD), aspectRatio: "612 / 792" }}
            />
          ) : (
            Array.from({ length: count }, (_, i) => {
              const n = i + 1;
              const here = matches?.filter((m) => m.page === n) ?? [];
              return (
                <div
                  key={n}
                  data-page={n}
                  role="img"
                  aria-label={`Page ${n}`}
                  className={v.page}
                  style={{ width: pageW, height: pageH }}
                >
                  {drawn.has(n) && <PageCanvas doc={doc} n={n} scale={scale} />}
                  {here.flatMap((m) =>
                    m.parts.map((part) => (
                      <Highlight
                        key={`${part.item}-${part.start}`}
                        doc={doc}
                        page={n}
                        part={part}
                        items={texts.current.get(n) ?? []}
                        scale={scale}
                        current={matches?.[at] === m}
                      />
                    )),
                  )}
                </div>
              );
            })
          )}
        </section>
      </div>
    </div>
  );
}

/** One page, drawn sharp for this screen's pixel density; cancelled and let go when it leaves the view. */
function PageCanvas({ doc, n, scale }: { doc: PdfDoc; n: number; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let task: { cancel(): void } | null = null;
    let live = true;
    void doc.getPage(n).then((page) => {
      const canvas = ref.current;
      if (!live || !canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const vp = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const r = page.render({ canvas, canvasContext: ctx, viewport: vp });
      task = r;
      r.promise.then(
        () => live && setReady(true),
        () => undefined,
      );
    });
    return () => {
      live = false;
      task?.cancel();
      const c = ref.current;
      // Let the memory go now, not when the browser gets round to it.
      if (c) {
        c.width = 0;
        c.height = 0;
      }
    };
  }, [doc, n, scale]);
  return <canvas ref={ref} className={v.pageCanvas} data-ready={ready || undefined} aria-hidden />;
}

/** A small picture of a page in the strip, drawn once it scrolls into the strip's view. */
function PageThumb({
  doc,
  n,
  ratio,
  current,
  onPick,
}: {
  doc: PdfDoc;
  n: number;
  ratio: number;
  current: boolean;
  onPick(): void;
}) {
  const box = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  const reduce = !!useReducedMotion();
  useEffect(() => {
    const el = box.current;
    if (!el || seen || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (current) box.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [current, reduce]);
  return (
    <button
      ref={box}
      type="button"
      data-thumb={n}
      className={v.thumbPage}
      aria-label={`Page ${n}`}
      aria-current={current ? "page" : undefined}
      onClick={onPick}
    >
      <span className={v.thumbPaper} style={{ aspectRatio: `1 / ${ratio}` }}>
        {seen && <PageCanvas doc={doc} n={n} scale={88 / 612} />}
      </span>
      <span className={v.thumbNum}>{n}</span>
    </button>
  );
}

/** A match from Find in it, over its words in one piece of the page's text (a match across pieces has one each). */
function Highlight({
  doc,
  page: pageNumber,
  part,
  items,
  scale,
  current,
}: {
  doc: PdfDoc;
  page: number;
  part: FoundPart;
  items: PdfTextItem[];
  scale: number;
  current: boolean;
}) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const it = items[part.item];
    if (!it) return;
    let live = true;
    void doc.getPage(pageNumber).then((page) => {
      if (!live) return;
      const vp = page.getViewport({ scale });
      const [, , , dh = 12, x = 0, y = 0] = it.transform;
      const h = it.height || Math.abs(dh);
      const per = it.str.length ? it.width / it.str.length : 0;
      const x1 = x + per * part.start;
      const [ax, ay, bx, by] = vp.convertToViewportRectangle([
        x1,
        y - h * 0.2,
        x1 + per * part.length,
        y + h * 0.9,
      ]);
      setRect({
        left: Math.min(ax!, bx!),
        top: Math.min(ay!, by!),
        width: Math.abs(bx! - ax!),
        height: Math.abs(by! - ay!),
      });
    });
    return () => {
      live = false;
    };
  }, [doc, pageNumber, part, items, scale]);
  if (!rect) return null;
  return <mark className={v.hit} data-current={current || undefined} style={rect} aria-hidden />;
}
