import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  EMPTY_WHATS_NEW,
  can,
  releaseFor,
  releaseStart,
  storiesFor,
  usedKey,
  windowDue,
  type StoryId,
  type WhatsNewState,
} from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError } from "../../http/errors";
import { available } from "../ai/service";
import { whatsappOn } from "../whatsapp/service";

/** What's new in LUME (spec 2026-11-02): the running version's stories this person may see, and their state. */
export type WhatsNewView = { version: string; stories: StoryId[]; state: WhatsNewState };

export const whatsNewOf = (row: { whatsNew: Partial<WhatsNewState> }): WhatsNewState => ({
  ...EMPTY_WHATS_NEW,
  ...row.whatsNew,
  used: row.whatsNew.used ?? [],
});

const runningVersion = (d: AppDeps): string => d.config.version ?? "";

/**
 * For `/auth/me`: the stories of the running version this person can open (their role, and the feature on here), and
 * whether the window is due. Someone who joined on or after the release is kept as having seen it: everything is new to
 * them, and onboarding and the tour show them around.
 */
export async function whatsNewFor(
  req: FastifyRequest,
  d: AppDeps,
  u: { id: string; createdAt: Date; whatsNew: Partial<WhatsNewState> },
): Promise<{ whatsNew: WhatsNewView; due: boolean }> {
  const version = runningVersion(d);
  const release = releaseFor(version);
  const state = whatsNewOf(u);
  if (!release) return { whatsNew: { version, stories: [], state }, due: false };
  const ai = (await available(req, d)).ok;
  const whatsapp = await whatsappOn(req);
  const stories = storiesFor(release, { can: (p) => can(req.actor!, p), on: { ai, whatsapp } });
  const due = windowDue({ state, release, stories, joinedAt: u.createdAt });
  if (state.seen !== version && u.createdAt.getTime() >= releaseStart(release)) {
    await req.db
      .update(schema.users)
      .set({ whatsNew: sql`${schema.users.whatsNew} || jsonb_build_object('seen', ${version}::text)` })
      .where(eq(schema.users.id, u.id));
    state.seen = version;
  }
  return { whatsNew: { version, stories: stories.map((s) => s.id), state }, due };
}

/**
 * `PUT /api/v1/me/whats-new`: the window seen, a story used, the Today pill put away. Only for the running version: a
 * tab opened before an update says so instead of marking a version nobody showed them.
 */
export async function updateWhatsNew(
  req: FastifyRequest,
  d: AppDeps,
  patch: { seen?: string; used?: StoryId; pillGone?: string },
): Promise<{ whatsNew: WhatsNewState }> {
  const version = runningVersion(d);
  const stale = (v: string | undefined) => v !== undefined && v !== version;
  if (!releaseFor(version) || stale(patch.seen) || stale(patch.pillGone))
    throw new HttpError(409, "STALE_VERSION", "LUME has been updated. Reload to see what's new.");
  const userId = req.actor!.userId;
  const [u] = await req.db.select().from(schema.users).where(eq(schema.users.id, userId)).for("update");
  const state = whatsNewOf(u!);
  const used = patch.used ? usedKey(version, patch.used) : null;
  const next: WhatsNewState = {
    seen: patch.seen ?? state.seen,
    used: used && !state.used.includes(used) ? [...state.used, used] : state.used,
    pillGone: patch.pillGone ?? state.pillGone,
  };
  await req.db.update(schema.users).set({ whatsNew: next }).where(eq(schema.users.id, userId));
  return { whatsNew: next };
}
