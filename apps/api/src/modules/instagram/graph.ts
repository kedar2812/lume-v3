/**
 * Instagram's Graph API, as this LUME calls it with each connected account's own token (Instagram API with Instagram
 * Login; NEW_FEATURES_PLAN §4). Connecting goes through the relay (it holds the app secret); everything after that is
 * this server and Meta. Every call answers, never throws: `{ ok, status, data }`, status 0 when Meta couldn't be
 * reached.
 */
export type IgGraphConfig = { graphUrl: string; version: string };
export type GraphAnswer = { ok: boolean; status: number; data: Record<string, unknown> };

const TIMEOUT_MS = 15_000;

async function call(url: string, init: RequestInit & { token?: string } = {}): Promise<GraphAnswer> {
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

export function igGraph(g: IgGraphConfig, token: string) {
  const at = (path: string, q: Record<string, string> = {}) => {
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
