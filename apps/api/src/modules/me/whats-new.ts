import { eq, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import {
  EMPTY_WHATS_NEW,
  can,
  releaseFor,
  startedOn,
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
import { relayOf, whatsappOn } from "../whatsapp/service";

/** What's new in LUME (spec 2026-11-02): the running version's stories this person may see, and their state. */
export type WhatsNewView = {
  version: string;
  stories: StoryId[];
  state: WhatsNewState;
  /** The day "New" and "joined after" count from here (YYYY-MM-DD): see startedOn(). */
  since?: string;
};

/** The day this installation first ran `version`, kept on the first ask (every client updates on its own day). */
async function firstRunOf(req: FastifyRequest, version: string): Promise<Date> {
  await req.db.insert(schema.appReleases).values({ version }).onConflictDoNothing();
  const [row] = await req.db
    .select({ at: schema.appReleases.firstRunAt })
    .from(schema.appReleases)
    .where(eq(schema.appReleases.version, version));
  return row?.at ?? new Date();
}

export const whatsNewOf = (row: { whatsNew: Partial<WhatsNewState> }): WhatsNewState => ({
  ...EMPTY_WHATS_NEW,
  ...row.whatsNew,
  used: row.whatsNew.used ?? [],
});

const runningVersion = (d: AppDeps): string => d.config.version ?? "";

/**
 * Whether a lead's message would really arrive here: WhatsApp switched on, set up on this installation (the relay and
 * Meta), and a number connected (final review 2026-11-05: a switch alone told people about chats they couldn't get).
 */
async function chatsLive(req: FastifyRequest, d: AppDeps): Promise<boolean> {
  if (!relayOf(d) || !d.meta || !(await whatsappOn(req))) return false;
  const [n] = await req.db
    .select({ id: schema.whatsappNumbers.id })
    .from(schema.whatsappNumbers)
    // Needing attention still receives: only a disconnected number stops messages arriving.
    .where(ne(schema.whatsappNumbers.status, "disconnected"))
    .limit(1);
  return !!n;
}

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
  const whatsapp = await chatsLive(req, d);
  const stories = storiesFor(release, { can: (p) => can(req.actor!, p), on: { ai, whatsapp } });
  const since = startedOn(release, await firstRunOf(req, version));
  const due = windowDue({ state, release, stories, joinedAt: u.createdAt, since });
  if (state.seen !== version && u.createdAt.getTime() >= since) {
    await req.db
      .update(schema.users)
      .set({ whatsNew: sql`${schema.users.whatsNew} || jsonb_build_object('seen', ${version}::text)` })
      .where(eq(schema.users.id, u.id));
    state.seen = version;
  }
  return {
    whatsNew: {
      version,
      stories: stories.map((s) => s.id),
      state,
      since: new Date(since).toISOString().slice(0, 10),
    },
    due,
  };
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
