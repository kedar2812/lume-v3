import { eventKey, type IgMessageEvent } from "@lume/core";
import type { AppDeps } from "../../app";
import { igGraph, type IgGraph } from "./graph";
import { igEventContext } from "./receive";
import { igGraphOf, igTokenContext, instagramRelayOf, tellAdmins } from "./service";

/** What the relay keeps for this LUME (apps/connect routes-store.ts): never a message, only what to act on. */
type Note =
  | { id: string; kind: "gap"; accountIds: string[]; from: number; to: number }
  | { id: string; kind: "delete" | "deauthorize"; userId: string; at: number };

/** Meta's Conversations API allows 2 calls a second per account: one call every half second keeps under it. */
const CALL_GAP_MS = 500;
/** A message just before the gap began is looked at too (clocks differ a little). */
const SLACK_MS = 5 * 60_000;
const PAGES_MAX = 20;
const DEAUTHORIZED = "Instagram said LUME may no longer use this account. Connect it again to use it.";

export type NotesDeps = Pick<AppDeps, "pool" | "keyring" | "clock" | "instagramGraph" | "instagram"> &
  Partial<Pick<AppDeps, "jobPool" | "whatsappRelay" | "googleOAuth">> & {
    sleep?: (ms: number) => Promise<void>;
    log?: { warn(o: unknown, m: string): void; error(o: unknown, m: string): void };
  };

type Account = { id: string; ig_user_id: string; username: string; status: string; token_enc: Buffer | null };

/**
 * Messages people sent while this LUME couldn't take Meta's deliveries (the relay noted the gap): read from Meta's
 * Conversations API, newest 20 a conversation, and put through the same keep-once door as a delivery, so a message LUME
 * already has is never kept twice. The business's own messages aren't read back.
 */
/** Meta didn't answer while catching up: the note stays at the relay for the next run, so nothing is lost. */
class CatchUpFailed extends Error {}

async function catchUp(
  d: NotesDeps,
  a: Account,
  g: IgGraph,
  token: string,
  from: number,
  sleep: (ms: number) => Promise<void>,
) {
  const pool = d.jobPool ?? d.pool;
  const graphUrl = igGraphOf(d as AppDeps).graphUrl;
  const queued: number[] = [];
  let page = await g.conversations(a.ig_user_id);
  for (let pages = 0; pages < PAGES_MAX; pages++) {
    if (!page.ok) throw new CatchUpFailed(`conversations page ${pages} answered ${page.status}`);
    const list = (Array.isArray(page.data.data) ? page.data.data : []) as {
      id?: unknown;
      updated_time?: unknown;
    }[];
    let older = false;
    for (const c of list) {
      if (typeof c.id !== "string") continue;
      const updated = typeof c.updated_time === "string" ? Date.parse(c.updated_time) : NaN;
      if (Number.isFinite(updated) && updated < from - SLACK_MS) {
        older = true; // the list is newest first: the rest are older still
        break;
      }
      await sleep(CALL_GAP_MS);
      const conv = await g.conversation(c.id);
      if (!conv.ok) throw new CatchUpFailed(`a conversation answered ${conv.status}`);
      const msgs = ((conv.data.messages as { data?: unknown } | undefined)?.data ?? []) as {
        id?: unknown;
        created_time?: unknown;
        from?: { id?: unknown };
        message?: unknown;
      }[];
      for (const m of msgs) {
        const sender = m.from?.id === undefined ? "" : String(m.from.id);
        const created = typeof m.created_time === "string" ? Date.parse(m.created_time) : NaN;
        if (typeof m.id !== "string" || !sender || sender === a.ig_user_id || !Number.isFinite(created))
          continue;
        if (created < from - SLACK_MS) continue;
        const ev: IgMessageEvent = {
          kind: "message",
          accountId: a.ig_user_id,
          igsid: sender,
          mid: m.id,
          at: new Date(created).toISOString(),
          text: typeof m.message === "string" ? m.message : null,
          attachments: [],
          replyToStory: null,
          storyMention: null,
          quickReply: null,
          referral: null,
          isEcho: false,
        };
        const key = eventKey(ev);
        const r = await pool.query<{ id: string }>(
          `INSERT INTO instagram_events (account_ig_id, event_key, kind, event_enc, status)
           VALUES ($1, $2, 'message', $3, 'queued') ON CONFLICT (account_ig_id, event_key) DO NOTHING RETURNING id`,
          [a.ig_user_id, key, d.keyring.encrypt(JSON.stringify(ev), igEventContext(a.ig_user_id, key))],
        );
        if (r.rows[0]) queued.push(Number(r.rows[0].id));
      }
    }
    const next = (page.data.paging as { next?: unknown } | undefined)?.next;
    // Only Meta's own next page (never a link elsewhere, which would carry the token).
    if (older || typeof next !== "string" || !next.startsWith(`${graphUrl}/`)) break;
    await sleep(CALL_GAP_MS);
    const r = await fetch(next, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    page = {
      ok: !!r?.ok,
      status: r?.status ?? 0,
      data: ((await r?.json().catch(() => null)) ?? {}) as Record<string, unknown>,
    };
  }
  for (const id of queued) await d.instagram?.enqueue(id).catch(() => undefined);
  return queued.length;
}

/**
 * Everything the relay kept for this LUME, acted on, then cleared there (NEW_FEATURES_PLAN §4.2, §7.2): a gap is
 * caught up from Meta; Meta's deauthorize disconnects the account; Meta's data deletion request disconnects it and
 * removes what Instagram sent LUME for it (lume_instagram_forget). A note for an account this LUME doesn't have is
 * cleared. A note whose work fails stays for the next run. Answers how many notes were done.
 */
export async function takeRelayNotes(d: NotesDeps): Promise<number> {
  const relay = instagramRelayOf(d as AppDeps);
  if (!relay) return 0;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pool = d.jobPool ?? d.pool;
  const auth = { authorization: `Bearer ${relay.relayToken}` };
  const r = await fetch(`${relay.relayUrl}/ig/notes`, {
    headers: auth,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!r?.ok) return 0;
  const notes = (((await r.json().catch(() => null)) as { notes?: unknown } | null)?.notes ?? []) as Note[];
  const done: string[] = [];
  for (const n of notes) {
    try {
      if (n.kind === "gap") {
        for (const igId of n.accountIds) {
          const a = (
            await pool.query<Account>(
              "SELECT id, ig_user_id, username, status, token_enc FROM instagram_accounts WHERE ig_user_id = $1",
              [igId],
            )
          ).rows[0];
          if (!a || a.status !== "active" || !a.token_enc) continue;
          const token = d.keyring.decrypt(a.token_enc, igTokenContext(a.id));
          await catchUp(d, a, igGraph(igGraphOf(d as AppDeps), token), token, n.from, sleep);
        }
      } else {
        const gone = await pool.query<{ id: string; username: string }>(
          `UPDATE instagram_accounts SET status = 'disconnected', token_enc = NULL, problem = $2, updated_at = now()
            WHERE ig_user_id = $1 AND status <> 'disconnected' RETURNING id, username`,
          [n.userId, DEAUTHORIZED],
        );
        const a =
          gone.rows[0] ??
          (
            await pool.query<{ id: string; username: string }>(
              "SELECT id, username FROM instagram_accounts WHERE ig_user_id = $1",
              [n.userId],
            )
          ).rows[0];
        if (a && n.kind === "delete") {
          const c = await pool.connect();
          try {
            await c.query("BEGIN");
            await c.query("SELECT lume_instagram_forget($1)", [a.id]);
            await c.query("COMMIT");
          } catch (e) {
            await c.query("ROLLBACK").catch(() => undefined);
            throw e;
          } finally {
            c.release();
          }
        }
        if (gone.rows[0])
          await tellAdmins(
            pool,
            n.kind === "delete"
              ? `Instagram @${gone.rows[0].username} was disconnected at the account's request`
              : `Instagram @${gone.rows[0].username} was disconnected on Instagram`,
            n.kind === "delete"
              ? "Meta asked LUME to delete what Instagram sent about this account. Its messages' words are gone; its leads stay."
              : DEAUTHORIZED,
          );
      }
      done.push(n.id);
    } catch (err) {
      d.log?.error(
        { err, note: n.kind },
        "an Instagram relay note couldn't be done; it's tried again next time",
      );
    }
  }
  if (done.length)
    await fetch(`${relay.relayUrl}/ig/notes/clear`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ids: done }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
  return done.length;
}
