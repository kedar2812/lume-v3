import { NextResponse, type NextRequest } from "next/server";

/**
 * What works without a session: the signed-out screens (matched by whole path segment, so a look-alike
 * such as /sign-in-x is not public) and the public files they need. Everything else needs a session.
 */
const PUBLIC_PATHS = [
  /^\/(sign-in|setup|forgot|design)(\/|$)/,
  /^\/(invite|reset)\/[^/]+$/, // a token, or /invite/not-found
  /^\/(fonts|brand)\/[\w.-]+$/,
  /^\/(lume-mark|icon)\.png$/,
];

/**
 * Per-request nonce CSP (report §12.3: no inline scripts) plus the signed-out redirect. The cookie's
 * presence is only a shortcut to save a round trip; requireSession() and the API remain the authority.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!request.cookies.has("__Host-lume_session") && !PUBLIC_PATHS.some((p) => p.test(pathname))) {
    const to = request.nextUrl.clone();
    to.pathname = "/sign-in";
    to.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(to);
  }
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|lume-mark.png).*)" }],
};
