import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "./api";
import { requestPasswordReset, resetPassword, signIn, verifyOtp, verifyRecoveryCode } from "./auth-client";

const csrf = () =>
  new Response(JSON.stringify({ token: "t" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const route = (map: Record<string, () => Response>) =>
  vi.fn(async (url: string | URL) => {
    const key = String(url);
    if (key.endsWith("/auth/csrf")) return csrf();
    const hit = Object.entries(map).find(([p]) => key.endsWith(p));
    if (!hit) throw new Error(`unexpected ${key}`);
    return hit[1]();
  });

beforeEach(() => {
  resetCsrfForTests();
  vi.restoreAllMocks();
});

describe("sign in", () => {
  it("reports done, otp, wrong credentials and lockout with its wait", async () => {
    vi.stubGlobal("fetch", route({ "/auth/login": () => json(200, { next: "done" }) }));
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "ok" });
    vi.stubGlobal("fetch", route({ "/auth/login": () => json(200, { next: "otp" }) }));
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "otp_required" });
    vi.stubGlobal(
      "fetch",
      route({ "/auth/login": () => json(401, { error: { code: "INVALID_CREDENTIALS", message: "no" } }) }),
    );
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "invalid" });
    vi.stubGlobal(
      "fetch",
      route({
        "/auth/login": () =>
          json(429, {
            error: { code: "TOO_MANY_ATTEMPTS", message: "wait", details: { retryAfterSec: 840 } },
          }),
      }),
    );
    expect(await signIn("a@b.c", "pw")).toEqual({ status: "locked", retryAfterSec: 840 });
  });

  it("verifies a code from the app and a recovery code", async () => {
    vi.stubGlobal("fetch", route({ "/auth/2fa": () => json(200, { next: "done" }) }));
    expect(await verifyOtp("123456")).toBe("ok");
    vi.stubGlobal(
      "fetch",
      route({ "/auth/2fa": () => json(401, { error: { code: "INVALID_CODE", message: "no" } }) }),
    );
    expect(await verifyOtp("123456")).toBe("invalid");
    vi.stubGlobal("fetch", route({ "/auth/recovery": () => json(200, { next: "done", remaining: 8 }) }));
    expect(await verifyRecoveryCode("AAAAA-BBBBB")).toBe("ok");
    vi.stubGlobal(
      "fetch",
      route({ "/auth/recovery": () => json(429, { error: { code: "TOO_MANY_ATTEMPTS", message: "wait" } }) }),
    );
    expect(await verifyRecoveryCode("AAAAA-BBBBB")).toBe("locked");
  });
});

describe("password reset", () => {
  it("always reports sent, so no address is confirmed or denied", async () => {
    vi.stubGlobal("fetch", route({ "/password/forgot": () => new Response(null, { status: 202 }) }));
    expect(await requestPasswordReset("ghost@nowhere.test")).toBe("sent");
  });

  it("separates a weak password from an expired link", async () => {
    vi.stubGlobal("fetch", route({ "/password/reset": () => new Response(null, { status: 204 }) }));
    expect(await resetPassword("t".repeat(43), "a long new passphrase")).toEqual({ status: "ok" });
    vi.stubGlobal(
      "fetch",
      route({
        "/password/reset": () =>
          json(400, {
            error: { code: "WEAK_PASSWORD", message: "weak", details: { problems: ["too_short"] } },
          }),
      }),
    );
    expect(await resetPassword("t".repeat(43), "short")).toEqual({ status: "weak", problems: ["too_short"] });
    vi.stubGlobal(
      "fetch",
      route({ "/password/reset": () => json(400, { error: { code: "INVALID_TOKEN", message: "expired" } }) }),
    );
    expect(await resetPassword("t".repeat(43), "a long new passphrase")).toEqual({ status: "expired" });
  });
});
