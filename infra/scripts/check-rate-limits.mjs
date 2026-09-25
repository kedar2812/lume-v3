// Checks the edge's rate limits against a running stack (dev: through Caddy's TLS on the build host).
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node infra/scripts/check-rate-limits.mjs [https://lume.localhost:8443]
//
// What must hold (found when three browsers behind one address — like an office — got 429s):
//   1. Static files (JS chunks, fonts, flags) are never limited: a page view loads dozens of them.
//   2. Each signed-in session has its own allowance, so colleagues sharing one IP don't starve each other.
//   3. One client without a session is still limited, and so is one IP as a whole (a generous ceiling).
const BASE = process.argv[2] ?? "https://lume.localhost:8443";
const SESSION = "__Host-lume_session";

async function burst(n, url, cookie) {
  let limited = 0;
  const one = async () => {
    const r = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: "manual" });
    await r.arrayBuffer();
    if (r.status === 429) limited++;
  };
  for (let i = 0; i < n; i += 25) await Promise.all(Array.from({ length: Math.min(25, n - i) }, one));
  return limited;
}
let failed = false;
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed = true;
};

const html = await (await fetch(`${BASE}/sign-in`)).text();
const chunk = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0];
if (!chunk) throw new Error("no JS chunk found on /sign-in");

check((await burst(700, `${BASE}${chunk}`)) === 0, "700 static file requests in a minute: none limited");
check(
  (await burst(450, `${BASE}/healthz`, `${SESSION}=check-a`)) === 0 &&
    (await burst(450, `${BASE}/healthz`, `${SESSION}=check-b`)) === 0,
  "two sessions on one IP, 450 requests each: neither limited",
);
check((await burst(650, `${BASE}/healthz`)) > 0, "one client without a session is limited after 600");
process.exit(failed ? 1 : 0);
