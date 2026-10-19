import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { schema } from "@lume/db";

/**
 * Settings → Messages (4C): how many leads a run holds, and how many queued sends a person makes a day; and (W3b-2) an
 * admin's own monthly limit on paid WhatsApp messages, under the plan's (null: only the plan's).
 */
export type MessagingSettings = { queueSize: number; dailyCap: number; paidSendsMonthly: number | null };
export const MESSAGING_DEFAULTS: MessagingSettings = { queueSize: 50, dailyCap: 150, paidSendsMonthly: null };

/** Each changes on its own. */
export const messagingBody = z
  .object({
    queueSize: z.number().int().min(1).max(200),
    dailyCap: z.number().int().min(1).max(500),
    paidSendsMonthly: z.number().int().min(1).max(10_000_000).nullable(),
  })
  .partial()
  .strict();

/** What's saved, over the defaults; `forUpdate` locks the row so two changes can't overwrite each other. */
export async function readMessaging(
  req: FastifyRequest,
  o: { forUpdate?: boolean } = {},
): Promise<MessagingSettings> {
  const [row] = o.forUpdate
    ? ((await req.db.execute(sql`SELECT messaging FROM settings WHERE id = 1 FOR UPDATE`)).rows as {
        messaging: Partial<MessagingSettings>;
      }[])
    : await req.db
        .select({ messaging: schema.settings.messaging })
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
  const saved = messagingBody.safeParse(row?.messaging ?? {});
  return { ...MESSAGING_DEFAULTS, ...(saved.success ? saved.data : {}) };
}
