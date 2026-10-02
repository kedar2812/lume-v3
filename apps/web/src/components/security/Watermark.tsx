"use client";
import { useMemo } from "react";
import s from "./watermark.module.css";

/** "Oct 1" from the business's date ("2026-10-01"), the watermark's day. */
export function monthDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? day
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
}

export const watermarkText = (v: { name: string; email: string; today: string }) =>
  `${v.name} · ${v.email} · ${monthDay(v.today)}`;

const escapeXml = (t: string) =>
  t.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );

/**
 * One tile of the pattern: the line of text, turned. Used as a mask over the theme's own text colour, so it is
 * right in Porcelain and Obsidian without a second image, and nothing per tile is added to the page.
 */
function tile(text: string): { url: string; w: number; h: number } {
  // Room for the turned line with a margin all round, so no tile ever cuts its text.
  const tw = text.length * 7.2;
  const w = Math.round(tw * Math.cos(0.42) + 72);
  const h = Math.round(tw * Math.sin(0.42) + 64);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" transform="rotate(-24 ${w / 2} ${h / 2})" ` +
    `font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" font-weight="600">${escapeXml(text)}</text></svg>`;
  return { url: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, w, h };
}

/**
 * The on-screen watermark (spec §2.6): a faint, repeating "name · email · date" over lead screens. It can't stop a
 * screenshot, only say whose it was. It never takes a click, a selection or a screen reader's attention, and it
 * prints too.
 */
export function Watermark({
  text,
  className,
  scale = 1,
}: {
  text: string;
  className?: string;
  /** Smaller tiles for a small surface (the Settings preview), so the whole line shows there. */
  scale?: number;
}) {
  const t = useMemo(() => tile(text), [text]);
  return (
    <div
      aria-hidden
      data-watermark={text}
      className={[s.mark, className].filter(Boolean).join(" ")}
      style={{ maskImage: t.url, maskSize: `${Math.round(t.w * scale)}px ${Math.round(t.h * scale)}px` }}
    />
  );
}
