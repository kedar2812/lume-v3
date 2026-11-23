/**
 * Instagram's Graph API, as this LUME calls it with each connected account's own token (Instagram API with Instagram
 * Login; NEW_FEATURES_PLAN §4). Connecting goes through the relay (it holds the app secret); everything after that is
 * this server and Meta. Every call answers, never throws: `{ ok, status, data }`, status 0 when Meta couldn't be
 * reached.
 */
export type IgGraphConfig = { graphUrl: string; version: string };
export type GraphAnswer = { ok: boolean; status: number; data: Record<string, unknown> };

const TIMEOUT_MS = 15_000;
/** Each part of a Graph path: Meta's ids (digits, or a conversation's letters, digits, - _ =) and its own words. */
const SEGMENT = /^[A-Za-z0-9_=-]{1,200}$/;
/** An id that would change the address (a slash, "..", ? or #): refused here, never sent to Meta. */
const REFUSED: GraphAnswer = {
  ok: false,
  status: 400,
  data: { error: { code: 100, message: "Not an id Meta gave" } },
};

async function call(url: string | null, init: RequestInit & { token?: string } = {}): Promise<GraphAnswer> {
  if (url === null) return REFUSED;
  const { token, ...rest } = init;
  const r = await fetch(url, {
    ...rest,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!r) return { ok: false, status: 0, data: {} };
  const data = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data };
}

export const graphPathSafe = (path: string) => path.split("/").every((p) => SEGMENT.test(p));

export function igGraph(g: IgGraphConfig, token: string) {
  // Ids come from webhooks and Meta's own answers: each is checked before it becomes part of an address.
  const at = (path: string, q: Record<string, string> = {}) => {
    if (!graphPathSafe(path)) return null;
    const u = new URL(`${g.graphUrl}/${g.version}/${path}`);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  };
  return {
    me: () => call(at("me", { fields: "user_id,username,name,account_type" }), { token }),
    /** One message (a DM, or a private reply to a comment): Meta's Send API. */
    send: (accountIgId: string, body: Record<string, unknown>) =>
      call(at(`${accountIgId}/messages`), { method: "POST", token, body: JSON.stringify(body) }),
    /** A public reply under a comment. */
    publicReply: (commentId: string, message: string) =>
      call(at(`${commentId}/replies`), { method: "POST", token, body: JSON.stringify({ message }) }),
    /** Name and username: allowed once the person has messaged the account. */
    profile: (igsid: string) =>
      call(at(igsid, { fields: "name,username,is_user_follow_business" }), { token }),
    /** Their profile photo's link (signed, expiring): asked on its own, so a photo that fails never costs a name. */
    photo: (igsid: string) => call(at(igsid, { fields: "profile_pic" }), { token }),
    unsubscribe: (accountIgId: string) =>
      call(at(`${accountIgId}/subscribed_apps`), { method: "DELETE", token }),
    conversations: (accountIgId: string) =>
      call(at(`${accountIgId}/conversations`, { platform: "instagram", fields: "id,updated_time" }), {
        token,
      }),
    conversation: (conversationId: string) =>
      call(at(conversationId, { fields: "messages{id,created_time,from,message}" }), { token }),
    /** A fresh 60-day token: no app secret needed, once the token is at least a day old (Meta). */
    refresh: () =>
      call(
        `${g.graphUrl}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token })}`,
      ),
  };
}
export type IgGraph = ReturnType<typeof igGraph>;
