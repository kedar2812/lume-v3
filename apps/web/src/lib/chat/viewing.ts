/**
 * The conversation on this tab's screen, and the thread open beside it, when the tab is being looked at: what lands
 * there is being read, so it never counts as unread anywhere else in the tab (the sidebar's number).
 */
const viewing = new Set<string>();
export const setViewing = (key: string, on: boolean): void => {
  if (on) viewing.add(key);
  else viewing.delete(key);
};
export const isViewing = (key: string): boolean => viewing.has(key);
/** What a thread is called here, as a conversation is by its id. */
export const threadKey = (root: number): string => `thread:${root}`;

/** A conversation was muted or unmuted in this tab: what counts has changed. */
const mutes = new Set<() => void>();
export const tellMuted = (): void => mutes.forEach((f) => f());
export const onMuted = (f: () => void): (() => void) => {
  mutes.add(f);
  return () => void mutes.delete(f);
};
