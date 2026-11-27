import { schema } from "@lume/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { HttpError, badRequest, conflict } from "../../http/errors";

/**
 * Which number a run sends from (spec 2026-11-26-run-number-choice): the connected numbers a person may send from (the
 * business's, their own, and for LUME AI the number of whoever it speaks as), and the one a run starts on.
 */
const N = schema.whatsappNumbers;

export type SendableNumber = {
  id: string;
  display: string;
  /** "the business's", or the person's ("Riya Sharma's"). */
  whose: string;
  /** Whose own it is; null: the business's. */
  ownerId: string | null;
  waba: string;
  quality: string | null;
  tier: string | null;
};

const whoseOf = (owner: string | null, name: string | null) =>
  owner ? `${name ?? "A teammate"}'s` : "the business's";

/** Connected numbers this person may send from: the business's first, then their own (and `also`'s), by number. */
export async function sendableNumbers(
  req: FastifyRequest,
  also?: string | string[],
): Promise<SendableNumber[]> {
  const mine = new Set([req.actor!.userId, ...(also === undefined ? [] : [also].flat())]);
  const rows = await req.db
    .select({
      id: N.id,
      display: N.displayPhone,
      owner: N.ownerUserId,
      name: schema.users.name,
      waba: N.wabaId,
      quality: N.quality,
      tier: N.messagingTier,
    })
    .from(N)
    .leftJoin(schema.users, eq(schema.users.id, N.ownerUserId))
    .where(eq(N.status, "active"));
  return rows
    .filter((r) => r.owner === null || mine.has(r.owner))
    .sort((a, b) => Number(a.owner !== null) - Number(b.owner !== null) || a.display.localeCompare(b.display))
    .map((r) => ({
      id: r.id,
      display: r.display,
      whose: whoseOf(r.owner, r.name),
      ownerId: r.owner,
      waba: r.waba,
      quality: r.quality,
      tier: r.tier,
    }));
}

/**
 * The number a run starts on: the one chosen, when it's one this person may send from; their only one when there's
 * one; none when there are none. Two or more and none chosen: the person is asked, never chosen for.
 */
export async function pickNumber(
  req: FastifyRequest,
  chosen: string | undefined,
  also?: string,
): Promise<SendableNumber | null> {
  const list = await sendableNumbers(req, also);
  if (chosen) {
    const n = list.find((x) => x.id === chosen);
    if (n) return n;
    const [row] = await req.db
      .select({ status: N.status, display: N.displayPhone, owner: N.ownerUserId })
      .from(N)
      .where(eq(N.id, chosen));
    if (row && row.status !== "active")
      throw conflict(
        "NUMBER_NOT_READY",
        row.status === "disconnected"
          ? `${row.display} isn't connected any more. Choose another number.`
          : `Connect ${row.display} again to send from it.`,
      );
    throw new HttpError(403, "NUMBER_NOT_YOURS", "Choose the business's number or your own.");
  }
  if (list.length > 1) throw badRequest("NUMBER_REQUIRED", "Choose the number this run sends from.");
  return list[0] ?? null;
}

/** A number as a run's screen says it: its display and whose it is. */
export async function numberLabel(
  req: FastifyRequest,
  id: string,
): Promise<{ display: string; whose: string } | null> {
  const [r] = await req.db
    .select({ display: N.displayPhone, owner: N.ownerUserId, name: schema.users.name })
    .from(N)
    .leftJoin(schema.users, eq(schema.users.id, N.ownerUserId))
    .where(eq(N.id, id));
  return r ? { display: r.display, whose: whoseOf(r.owner, r.name) } : null;
}
