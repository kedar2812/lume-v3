"use client";

/**
 * Browser calls to the API (spec §3). Same-origin, with the CSRF double-submit header and an
 * Idempotency-Key so a double click or a retry can never create two of anything (report §4.4).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

const OFFLINE = "LUME can’t reach the server right now. Check your connection and try again.";
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

async function send<T>(method: string, path: string, body?: unknown, retry = true): Promise<ApiResult<T>> {
  const token = await csrfToken();
  // A read changes nothing, so it carries no Idempotency-Key.
  const headers: Record<string, string> = method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() };
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
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (res.ok) return { ok: true, status: res.status, data: payload as T };
  const err = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  // A stale CSRF cookie (a long-open tab) is worth exactly one silent retry.
  if (res.status === 403 && err?.code === "CSRF" && retry) {
    await csrfToken(true);
    return send<T>(method, path, body, false);
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
  put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
  del: <T>(path: string) => send<T>("DELETE", path),
};
