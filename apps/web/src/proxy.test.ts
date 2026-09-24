import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

const visit = (path: string, signedIn = false) =>
  proxy(
    new NextRequest(`http://lume.test${path}`, {
      headers: signedIn ? { cookie: "__Host-lume_session=abc" } : {},
    }),
  );
const redirectedTo = (r: Response) => r.headers.get("location");

describe("proxy", () => {
  it("sends a signed-out visitor to sign-in, remembering where they were going", () => {
    expect(redirectedTo(visit("/leads"))).toBe("http://lume.test/sign-in?next=%2Fleads");
    expect(redirectedTo(visit("/"))).toBe("http://lume.test/sign-in");
  });

  it("lets the signed-out screens through", () => {
    for (const p of ["/sign-in", "/setup", "/invite/abc", "/forgot", "/reset/abc"])
      expect(redirectedTo(visit(p))).toBeNull();
  });

  // Found by the visual baselines: fonts were being redirected, so every signed-out screen fell back to
  // the system font. Public files must load for everyone.
  it("never redirects the public files those screens need", () => {
    for (const p of ["/fonts/InterVariable.woff2", "/brand/google-g.png", "/lume-mark.png", "/icon.png"])
      expect(redirectedTo(visit(p))).toBeNull();
  });

  it("does not treat a look-alike path as public", () => {
    expect(redirectedTo(visit("/sign-in-as-admin"))).not.toBeNull();
    expect(redirectedTo(visit("/fonts-list"))).not.toBeNull();
  });

  it("sets a fresh nonce CSP on every page", () => {
    const a = visit("/today", true).headers.get("content-security-policy")!;
    const b = visit("/today", true).headers.get("content-security-policy")!;
    expect(a).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(a).toContain("frame-ancestors 'none'");
    expect(a).not.toBe(b);
  });
});
