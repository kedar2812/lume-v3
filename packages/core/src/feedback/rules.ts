import { readImage, type ImageRead } from "../images/read";

/**
 * Feedback from a client's LUME (spec 2026-10-16): what a report is, and the limits both servers hold it to. Pure, so
 * the sheet in the browser shows the same limits the servers enforce.
 */
export const FEEDBACK_KINDS = ["bug", "idea", "confusing"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_THEMES = ["porcelain", "obsidian"] as const;
export type FeedbackTheme = (typeof FEEDBACK_THEMES)[number];

export const FEEDBACK_LIMITS = {
  text: 4000,
  /** The character count shows from here. */
  textCountFrom: 3500,
  images: 5,
  imageBytes: 1_572_864,
  longEdge: 2400,
  page: 300,
  browser: 300,
  screen: 40,
  name: 120,
  email: 254,
  role: 60,
  /** Five 1.5 MB images are 10 MB once base64-encoded; the rest of a report is small. */
  bodyBytes: 12 * 1024 * 1024,
  perPersonPerHour: 10,
} as const;

export type FeedbackReport = {
  kind: FeedbackKind;
  text: string;
  page: string;
  theme: FeedbackTheme;
  screen: string;
  images: { type: "image/webp" | "image/jpeg"; data: string }[];
};

/** A screenshot as both servers take it: a real WebP or JPEG, 1.5 MB at most, 2400 px at most on its long edge. */
export function checkFeedbackImage(b: Uint8Array): ImageRead {
  if (b.length === 0) return { ok: false, reason: "empty" };
  if (b.length > FEEDBACK_LIMITS.imageBytes) return { ok: false, reason: "over 1.5 MB" };
  return readImage(b, (w, h) =>
    w < 1 || h < 1
      ? "no size"
      : Math.max(w, h) > FEEDBACK_LIMITS.longEdge
        ? "over 2400 pixels on its long edge"
        : null,
  );
}

/**
 * The page a report came from, as it travels: the path only. What was searched (the query) and where on the page (the
 * hash) can hold a lead's name, so both go; so do control characters. Never anything but a path on this site.
 */
export function pagePath(raw: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what goes
  const path = (raw.split(/[?#]/)[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, "");
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path.slice(0, FEEDBACK_LIMITS.page);
}
