import type { PermissionKey } from "../rbac/catalog";
import { RELEASES, type Release, type Story, type StoryId } from "./releases";

/** Kept on the server per person: the last version whose window they saw, the stories they used, the pill put away. */
export type WhatsNewState = {
  seen: string | null;
  /** `"<version>:<storyId>"`. */
  used: string[];
  pillGone: string | null;
};

export const EMPTY_WHATS_NEW: WhatsNewState = Object.freeze({
  seen: null,
  used: [],
  pillGone: null,
}) as WhatsNewState;

const DAY_MS = 86_400_000;
const NEW_FOR_MS = 7 * DAY_MS;

/** The release day's first instant (UTC). */
export const releaseStart = (r: Release): number => Date.parse(`${r.date}T00:00:00Z`);

/**
 * Where "New" and "joined after the update" count from on this installation: the later of the release day and the day
 * it first ran the version (UTC). Every client updates on its own day (final review 2026-11-05).
 */
export function startedOn(r: Release, firstRunAt: Date | null): number {
  const release = releaseStart(r);
  if (!firstRunAt) return release;
  const day = Date.parse(`${firstRunAt.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(release, day);
}

export function releaseFor(version: string): Release | null {
  return RELEASES.find((r) => r.version === version) ?? null;
}

/** The stories this person may be told about: their role opens the place and the feature is on here. */
export function storiesFor(
  r: Release,
  o: { can: (p: PermissionKey) => boolean; on: { ai: boolean; whatsapp: boolean } },
): Story[] {
  return r.stories.filter((s) => o.can(s.permission) && (s.needs === null || o.on[s.needs]));
}

export function windowDue(o: {
  state: WhatsNewState;
  release: Release | null;
  stories: Story[];
  joinedAt: Date;
  /** startedOn() for this installation; the release day when absent. */
  since?: number;
}): boolean {
  if (!o.release || o.stories.length === 0) return false;
  if (o.state.seen === o.release.version) return false;
  // Everything is new to someone who joined on or after the release: onboarding and the tour show them around.
  return o.joinedAt.getTime() < (o.since ?? releaseStart(o.release));
}

export const usedKey = (version: string, story: StoryId): string => `${version}:${story}`;

/** "New" beside a story's place: for a week from the release, until it's used. */
export function isNew(o: {
  state: WhatsNewState;
  release: Release;
  story: StoryId;
  now: Date;
  /** startedOn() for this installation; the release day when absent. */
  since?: number;
}): boolean {
  if (o.state.used.includes(usedKey(o.release.version, o.story))) return false;
  return o.now.getTime() < (o.since ?? releaseStart(o.release)) + NEW_FOR_MS;
}
