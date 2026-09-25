"use client";

/**
 * Browser calls to the API (spec §3). Same-origin, with the CSRF double-submit header and an
 * Idempotency-Key so a double click or a retry can never create two of anything (report §4.4).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

const OFFLINE = "LUME can’t reach the server right now. Check your connection and try again.";
const BUSY = "Too many requests from this network right now. Wait a moment, then try again.";
/** A read that meets a busy edge waits this long at most (Retry-After, capped) and tries once more. */
const MAX_WAIT_MS = 3000;
let csrf: string | null = null;

/** Tests only. */
export function resetCsrfForTests(): void {
  csrf = null;
}

async function csrfToken(force = false): Promise<string | null> {
  if (csrf && !force) return csrf;
  try {
    const res = await fetch("/api/v1/auth/csrf", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return null;
    csrf = ((await res.json()) as { token?: string }).token ?? null;
    return csrf;
  } catch {
    return null;
  }
}

async function send<T>(
  method: string,
  path: string,
  body?: unknown,
  retry = true,
  extra: Record<string, string> = {},
): Promise<ApiResult<T>> {
  const token = await csrfToken();
  // A read changes nothing, so it carries no Idempotency-Key.
  const headers: Record<string, string> = {
    ...extra,
    ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
  };
  if (token) headers["x-csrf-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: "OFFLINE", message: OFFLINE };
  }
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // An error page from the edge (502, 504) rather than the API: no detail to read.
  }
  if (res.ok) return { ok: true, status: res.status, data: payload as T };
  const err = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  // A 429 from the edge (no API answer inside; the API's own lockouts explain themselves) means the
  // network is busy: a read is safe to repeat once after a short wait, a write never repeats on its own.
  if (res.status === 429 && !err?.code) {
    if (method === "GET" && retry) {
      const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(res.headers.get("retry-after") ?? 1) * 1000));
      await new Promise((r) => setTimeout(r, wait));
      return send<T>(method, path, body, false, extra);
    }
    return { ok: false, status: 429, code: "RATE_LIMITED", message: BUSY };
  }
  // A stale CSRF cookie (a long-open tab) is worth exactly one silent retry.
  if (res.status === 403 && err?.code === "CSRF" && retry) {
    await csrfToken(true);
    return send<T>(method, path, body, false, extra);
  }
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? "UNKNOWN",
    message: err?.message ?? "Something went wrong. Try again.",
    ...(err?.details !== undefined ? { details: err.details } : {}),
  };
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => send<T>("PATCH", path, body),
  /** A PATCH that only applies to the version the caller edited (optimistic concurrency, report §4.4). */
  patchIf: <T>(path: string, version: number, body?: unknown) =>
    send<T>("PATCH", path, body, true, { "if-match": `"${version}"` }),
  put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
  del: <T>(path: string) => send<T>("DELETE", path),
};
