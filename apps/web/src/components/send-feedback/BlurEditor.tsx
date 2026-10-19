"use client";
import { useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { normRect, toImageRect, type Point, type Rect } from "@/lib/feedback/shots";
import s from "./send-feedback.module.css";

/**
 * Blur private parts (spec 2026-10-16 §1.2; canvas board "Blur"): drag boxes over anything private; Undo takes the
 * last away; Done hands every box back, in the picture's own pixels, to be burned in before anything is sent. Boxes
 * from an earlier pass stay, and can be added to.
 */
export function BlurEditor({
  url,
  image,
  initial,
  onDone,
  onCancel,
}: {
  url: string;
  image: { w: number; h: number };
  initial: Rect[];
  onDone: (rects: Rect[]) => void;
  onCancel: () => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [rects, setRects] = useState<Rect[]>(initial);
  const [draft, setDraft] = useState<{ a: Point; b: Point } | null>(null);

  const at = (e: PointerEvent): Point => {
    const r = area.current!.getBoundingClientRect();
    return {
      x: Math.min(r.width, Math.max(0, e.clientX - r.left)),
      y: Math.min(r.height, Math.max(0, e.clientY - r.top)),
    };
  };
  const shown = () => {
    const r = area.current!.getBoundingClientRect();
    return { w: r.width, h: r.height };
  };
  // Kept in the picture's pixels, drawn as percentages, so they hold if the window resizes.
  const boxStyle = (r: Rect) => ({
    left: `${(r.x / image.w) * 100}%`,
    top: `${(r.y / image.h) * 100}%`,
    width: `${(r.w / image.w) * 100}%`,
    height: `${(r.h / image.h) * 100}%`,
  });
  const n = rects.length;
  const d = draft && normRect(draft.a, draft.b);

  return (
    <Dialog label="Blur private parts" onClose={onCancel} width={960}>
      <div className={s.blur}>
        <header className={s.blurHead}>
          <h2>Blur private parts</h2>
          <p>
            Drag over anything private: a lead&apos;s name, number or message. The blur is burned into the
            picture before it&apos;s sent.
          </p>
        </header>
        <div className={s.blurStage}>
          <div
            ref={area}
            className={s.blurArea}
            style={{
              aspectRatio: `${image.w} / ${image.h}`,
              width: `min(100%, calc(62dvh * ${image.w / image.h}))`,
            }}
            role="img"
            aria-label={`The screenshot, with ${n} blurred ${n === 1 ? "area" : "areas"}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              const p = at(e);
              setDraft({ a: p, b: p });
            }}
            onPointerMove={(e) => draft && setDraft({ ...draft, b: at(e) })}
            onPointerUp={() => {
              if (!d) return;
              setDraft(null);
              // A tap isn't a blur: too small to hide anything.
              if (d.w >= 8 && d.h >= 8) setRects([...rects, toImageRect(d, shown(), image)]);
            }}
            onPointerCancel={() => setDraft(null)}
          >
            {/* A local blob of the person's own screenshot. */}
            <img src={url} alt="" draggable={false} />
            {rects.map((r, i) => (
              <span key={i} className={s.blurBox} style={boxStyle(r)} />
            ))}
            {d && <span className={s.draftBox} style={{ left: d.x, top: d.y, width: d.w, height: d.h }} />}
          </div>
        </div>
        <footer className={s.blurFoot}>
          <Button onClick={() => setRects(rects.slice(0, -1))} disabled={n === 0}>
            Undo
          </Button>
          <span className={s.muted}>
            {n === 0 ? "Nothing blurred yet" : n === 1 ? "1 area blurred" : `${n} areas blurred`}
          </span>
          <span className={s.grow} />
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onDone(rects)}>
            Done
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
