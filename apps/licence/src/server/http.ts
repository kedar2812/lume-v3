/** A JSON answer that no cache keeps. */
export function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/**
 * Who's asking. The server listens on 127.0.0.1 only, behind the host's nginx, which sets X-Real-IP; nothing
 * else can reach it to set the header.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (fwd || "unknown").slice(0, 64);
}
