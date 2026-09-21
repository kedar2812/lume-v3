export type SignInResult =
  | { status: "ok" }
  | { status: "otp_required" }
  | { status: "invalid" }
  | { status: "locked" }
  | { status: "unavailable" };

async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/** Phase 1 implements POST /api/v1/auth/login → { next: "otp" | "done" } (report §12.1). */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const res = await post("/api/v1/auth/login", { email, password });
  if (!res) return { status: "unavailable" };
  if (res.status === 401) return { status: "invalid" };
  if (res.status === 423 || res.status === 429) return { status: "locked" };
  if (!res.ok) return { status: "unavailable" };
  const data = (await res.json().catch(() => ({}))) as { next?: string };
  return data.next === "otp" ? { status: "otp_required" } : { status: "ok" };
}

export async function verifyOtp(code: string): Promise<"ok" | "invalid" | "unavailable"> {
  const res = await post("/api/v1/auth/2fa", { code });
  if (!res) return "unavailable";
  if (res.status === 401 || res.status === 400) return "invalid";
  return res.ok ? "ok" : "unavailable";
}
