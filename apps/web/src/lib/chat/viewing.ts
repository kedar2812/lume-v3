/**
 * The conversation on this tab's screen, when the tab is being looked at: what lands there is being read, so it never
 * counts as unread anywhere else in the tab (the sidebar's number).
 */
let viewing: string | null = null;
export const setViewing = (id: string | null): void => {
  viewing = id;
};
export const isViewing = (id: string): boolean => viewing === id;

/** A conversation was muted or unmuted in this tab: what counts has changed. */
const mutes = new Set<() => void>();
export const tellMuted = (): void => mutes.forEach((f) => f());
export const onMuted = (f: () => void): (() => void) => {
  mutes.add(f);
  return () => void mutes.delete(f);
};
