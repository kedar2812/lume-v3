import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn, verifyOtp } from "./auth-client";

const respond = (status: number, body: unknown = {}) =>
  vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
afterEach(() => vi.restoreAllMocks());

describe("signIn", () => {
  it("posts JSON same-origin and maps outcomes", async () => {
    const f = respond(200, { next: "otp" });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "otp_required" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/login");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(init?.body))).toEqual({ email: "t@x.com", password: "pw" });

    respond(200, { next: "done" });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "ok" });
    respond(401, { error: { code: "INVALID_CREDENTIALS" } });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "invalid" });
    respond(423, { error: { code: "ACCOUNT_LOCKED" } });
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "locked" });
    respond(404);
    expect(await signIn("t@x.com", "pw")).toEqual({ status: "unavailable" });
  });

  it("treats network failures as unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    expect(await signIn("a@b.c", "x")).toEqual({ status: "unavailable" });
  });
});

describe("verifyOtp", () => {
  it("maps outcomes", async () => {
    respond(200);
    expect(await verifyOtp("123456")).toBe("ok");
    respond(401);
    expect(await verifyOtp("000000")).toBe("invalid");
    respond(502);
    expect(await verifyOtp("123456")).toBe("unavailable");
  });
});
