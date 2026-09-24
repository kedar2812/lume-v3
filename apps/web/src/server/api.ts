import { cookies } from "next/headers";

/**
 * Server-side calls to the API (spec §3). Inside the compose network the API is reachable at
 * http://api:3001; the visitor's session cookie is forwarded so the API decides what they may see.
 * Never cached: every render reflects the current session and data.
 */
const BASE = process.env.LUME_API_URL ?? "http://api:3001";

export type ApiResponse<T> = { status: number; data: T | null };

export async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const jar = await cookies();
  const cookie = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
      // A page render must never hang on the API.
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  } catch {
    return { status: 0, data: null };
  }
}
