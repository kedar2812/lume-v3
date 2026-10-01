import type pg from "pg";
import type { AppDeps } from "./app";
import { readAs } from "./modules/notifications/hub";
import { notify, type NewNotification } from "./modules/notifications/notify";

/**
 * What service code reaches through `req.server` beyond the database: notices (3B), stage automations' needs
 * (3C), and settling a follow-up's reminders. Decorated on the signed-in scope; a job that writes leads on
 * someone's behalf (a Calendly booking) is given the same, so it tells people what a person's change would.
 */
export function serverHelpers(deps: { pool: pg.Pool; tasks?: AppDeps["tasks"] }) {
  return {
    notify: (userId: string, n: NewNotification) => notify(deps.pool, userId, n),
    automationDeps: { pool: deps.pool, tasks: deps.tasks },
    settleReminders: (userId: string, taskId: string) =>
      readAs(deps.pool, userId, async (c) => {
        await c.query(
          `UPDATE notifications SET read_at = now()
            WHERE task_id = $1 AND read_at IS NULL AND kind IN ('follow_up_due', 'follow_up_soon', 'follow_up_nudge')`,
          [taskId],
        );
      }),
    notifyNameOf: async (userId: string) => {
      const { rows } = await deps.pool.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [
        userId,
      ]);
      return rows[0]?.name.split(" ")[0] ?? null;
    },
  };
}
