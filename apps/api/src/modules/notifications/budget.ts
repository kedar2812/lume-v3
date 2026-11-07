/**
 * The refresh budget (owner, 2026-11-06: "1000 people using it at the same time should raise no issues"). When leads
 * change, every open stream says so and its browser reads its counts again (the sidebar's views, Today's tiles). A small
 * team hears within 3 s, as before; a big one less often, so the whole team's re-reads stay near REREADS_PER_S however
 * many are connected, and each stream takes its own moment inside the window so they never all land at once.
 */
export const REREADS_PER_S = 60;
const FLOOR_MS = 3000;
/** How far apart one stream's "leads changed" may be, for this many open streams. */
export const leadsEveryMs = (streams: number): number =>
  Math.max(FLOOR_MS, Math.round((streams / REREADS_PER_S) * 1000));

/** The longest any stream waits on top of its window: 5 ms a stream, up to 5 s. */
const SPREAD_PER_STREAM_MS = 5;
const SPREAD_MAX_MS = 5000;

/**
 * When this stream says "leads changed": not before its window allows (`wait`), plus its own share of the spread, so a
 * thousand browsers' re-reads arrive over seconds rather than in the same instant. A small team barely waits.
 */
export function leadsDelay(o: { streams: number; wait: number; rand?: () => number }): number {
  const spread = Math.min(SPREAD_MAX_MS, o.streams * SPREAD_PER_STREAM_MS);
  return Math.max(0, o.wait) + Math.floor((o.rand ?? Math.random)() * spread);
}
