import { context } from "@/server/context";

export const dynamic = "force-dynamic";

/** Up, with its database (the image's health check). */
export async function GET(): Promise<Response> {
  try {
    await context().db.query("SELECT 1");
    return new Response("ok", { headers: { "cache-control": "no-store" } });
  } catch {
    return new Response("not ready: see the app's log", { status: 503 });
  }
}
