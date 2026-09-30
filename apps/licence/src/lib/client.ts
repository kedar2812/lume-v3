/** The panel's side of the admin API: JSON in and out, the CSRF token on every write, signed out → sign in. */
export type Result<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/** Said on window after any change, so the bell and the screens look again. */
export const CHANGED = "lume-licence:changed";

function csrf(): string {
  const m = /(?:^|;\s*)lume_licence_csrf=([^;]+)/.exec(
    typeof document === "undefined" ? "" : document.cookie,
  );
  return m ? decodeURIComponent(m[1]!) : "";
}

async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const r = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { "x-csrf-token": csrf() } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status === 401 && !path.startsWith("/api/auth/")) {
      window.location.assign("/sign-in");
      return { ok: false, status: 401, message: "Sign in again." };
    }
    const text = await r.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!r.ok) {
      const message =
        (data as { error?: { message?: string } } | null)?.error?.message ?? "Something went wrong.";
      return { ok: false, status: r.status, message };
    }
    if (method !== "GET") window.dispatchEvent(new Event(CHANGED));
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, message: "LUME couldn't reach the licence server. Check the connection." };
  }
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
};
