import { AiGlyph } from "@/components/ai/AiGlyph";
import { sourceOf, type MeetingSource } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import s from "./source.module.css";

/** What each source is called, in its chip and to a screen reader. */
export const SOURCE_NAME: Record<MeetingSource, string> = {
  google: "Google Calendar",
  calendly: "Calendly",
  lume_ai: "LUME AI",
};

/**
 * Where a meeting came from (owner 2026-11-27: "a clear proper indicator that differentiates calendly from google
 * calendar"): the company's own mark, unmodified (public/brand), or LUME AI's Loop. `words` adds its name beside it, a
 * chip for the agenda and the drawer; without, the mark alone (named for a screen reader), where room is short.
 */
export function SourceMark({
  m,
  words = false,
}: {
  m: Pick<Meeting, "matchedBy"> & { source?: Meeting["source"] };
  words?: boolean;
}) {
  const src = sourceOf(m);
  const name = SOURCE_NAME[src];
  const mark = <SourceIcon src={src} />;
  return words ? (
    <span className={s.chip} data-source={src}>
      {mark}
      {name}
    </span>
  ) : (
    <span className={s.only} role="img" aria-label={`From ${name}`} title={name} data-source={src}>
      {mark}
    </span>
  );
}

/** A source's mark alone (the From filter's choices). */
export function SourceIcon({ src }: { src: MeetingSource }) {
  return src === "lume_ai" ? (
    <span className={s.tile} aria-hidden>
      <AiGlyph size={11} />
    </span>
  ) : src === "calendly" ? (
    <img className={s.logo} src="/brand/calendly.svg" alt="" width={16} height={16} />
  ) : (
    <span className={s.tile} aria-hidden>
      <img src="/brand/google-calendar.png" alt="" width={12} height={12} />
    </span>
  );
}
