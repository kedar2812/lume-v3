import { cleanImage, FEEDBACK_LIMITS } from "@lume/core/shared";
import { blockSize, burnBox, encodeSteps, fitWithin, type Rect } from "./shots";

/** A screenshot as it will travel, and its thumbnail. */
export type Prepared = {
  type: "image/webp" | "image/jpeg";
  /** Base64, as it's sent. */
  data: string;
  /** An object URL for the thumbnail (revoke it when the screenshot goes). */
  url: string;
  width: number;
  height: number;
  bytes: number;
};

/** A picture the person chose, pasted or dropped; null when the browser can't read it as one. */
export async function loadImage(file: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

const toBlob = (c: HTMLCanvasElement, type: string, q: number) =>
  new Promise<Blob | null>((r) => c.toBlob(r, type, q));
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Burn a box in (spec 2026-10-16 §1.2: a heavy blur, then pixelation): what's under it is blurred first, so the
 * blocks aren't the plain averages that tools match against a known font, then drawn down to one pixel a block and
 * back up without smoothing. Opaque throughout, so nothing of the original shows through at an edge.
 */
function burn(ctx: CanvasRenderingContext2D, r: Rect) {
  const box = burnBox(r, ctx.canvas.width, ctx.canvas.height);
  if (!box) return;
  const { x, y, w, h } = box;
  const b = blockSize(box);
  const soft = document.createElement("canvas");
  soft.width = w;
  soft.height = h;
  const t = soft.getContext("2d", { alpha: false })!;
  t.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h); // the box as it is: no blank edge to blur in from
  t.filter = `blur(${Math.max(4, Math.round(b / 2))}px)`; // ignored where a browser has no canvas filters
  t.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  t.filter = "none";
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(w / b));
  small.height = Math.max(1, Math.ceil(h / b));
  const s = small.getContext("2d", { alpha: false })!;
  s.imageSmoothingEnabled = true;
  s.imageSmoothingQuality = "high";
  s.drawImage(soft, 0, 0, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
  ctx.restore();
}

/**
 * The screenshot as it will be sent (spec 2026-10-16 §1.2): drawn afresh, so no metadata survives; within 2400 px;
 * every blur burned into its pixels; WebP, or JPEG where the browser can't make WebP; with nothing the browser added
 * (cleanImage); stepped down until it is 1.5 MB or less. Blur boxes are in the source's own pixels.
 */
export async function encodeShot(source: ImageBitmap, rects: Rect[]): Promise<Prepared> {
  const fit = fitWithin(source.width, source.height, FEEDBACK_LIMITS.longEdge);
  for (const step of encodeSteps()) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(fit.w * step.scale));
    c.height = Math.max(1, Math.round(fit.h * step.scale));
    const ctx = c.getContext("2d")!;
    ctx.drawImage(source, 0, 0, c.width, c.height);
    const k = c.width / source.width;
    for (const r of rects) burn(ctx, { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
    let blob = await toBlob(c, "image/webp", step.quality);
    if (!blob || blob.type !== "image/webp") blob = await toBlob(c, "image/jpeg", step.quality);
    if (!blob) continue;
    const type = blob.type as Prepared["type"];
    // What the browser added (Chrome's colour profile in every WebP) goes; what's left is what's sent and shown.
    const bytes = cleanImage(new Uint8Array(await blob.arrayBuffer()), type);
    if (bytes.length <= FEEDBACK_LIMITS.imageBytes)
      return {
        type,
        data: base64(bytes),
        url: URL.createObjectURL(new Blob([bytes], { type })),
        width: c.width,
        height: c.height,
        bytes: bytes.length,
      };
  }
  throw new Error("This picture can't be made small enough to send");
}

export const canCapture = () =>
  typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";

/**
 * Capture this screen (spec 2026-10-16 §1.2): the browser asks; once allowed, the sheet steps out of view, one frame
 * of the tab is taken, and the stream stops at once. Refused or cancelled: null, and nothing else happens.
 */
export async function captureTab(hide: () => Promise<void>, show: () => void): Promise<ImageBitmap | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: false,
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
  } catch {
    return null;
  }
  try {
    await hide();
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // Two frames, so the sheet is gone from the picture.
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return await createImageBitmap(video);
  } catch {
    return null;
  } finally {
    for (const t of stream.getTracks()) t.stop();
    show();
  }
}
