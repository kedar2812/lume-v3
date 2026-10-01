import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { CalendlyError, createCalendly, type Calendly } from "./client";

let fake: CalendlyFake;
let c: Calendly;
const slept: number[] = [];
const HOOK = "https://lume.test/webhooks/calendly/abc";

beforeAll(async () => {
  fake = await startCalendlyFake();
  c = createCalendly({ token: fake.token, endpoint: fake.url, sleep: async (ms) => void slept.push(ms) });
});
afterAll(() => fake.close());
afterEach(() => {
  fake.subscriptions.splice(0);
  fake.orgAdmin = true;
  fake.freePlan = false;
  slept.length = 0;
});

const kind = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(CalendlyError);
  return (e as CalendlyError).kind;
};

describe("the Calendly client (5B Task 3)", () => {
  it("says who the token is, and their organization", async () => {
    expect(await c.me()).toEqual({
      uri: fake.user.uri,
      name: "Maya Kapoor",
      email: "maya@business.test",
      organization: fake.organization,
    });
  });

  it("subscribes the organization to bookings and cancellations, with LUME's signing key", async () => {
    const s = await c.subscribe({
      url: HOOK,
      signingKey: "k".repeat(40),
      organization: fake.organization,
      user: fake.user.uri,
    });
    expect(s).toMatchObject({ scope: "organization" });
    expect(fake.subscriptions).toEqual([
      {
        uri: s.uri,
        callbackUrl: HOOK,
        scope: "organization",
        signingKey: "k".repeat(40),
        events: ["invitee.created", "invitee.canceled"],
      },
    ]);
  });

  it("falls back to the token's own bookings when they don't administer the organization", async () => {
    fake.orgAdmin = false;
    const s = await c.subscribe({
      url: HOOK,
      signingKey: "k".repeat(40),
      organization: fake.organization,
      user: fake.user.uri,
    });
    expect(s.scope).toBe("user");
    expect(fake.subscriptions.map((x) => x.scope)).toEqual(["user"]);
  });

  it("replaces a subscription already at that address, so LUME holds its key", async () => {
    await c.subscribe({
      url: HOOK,
      signingKey: "old".repeat(14),
      organization: fake.organization,
      user: fake.user.uri,
    });
    const s = await c.subscribe({
      url: HOOK,
      signingKey: "new".repeat(14),
      organization: fake.organization,
      user: fake.user.uri,
    });
    expect(fake.subscriptions).toHaveLength(1);
    expect(fake.subscriptions[0]).toMatchObject({ uri: s.uri, signingKey: "new".repeat(14) });
  });

  it("unsubscribes", async () => {
    const s = await c.subscribe({
      url: HOOK,
      signingKey: "k".repeat(40),
      organization: fake.organization,
      user: fake.user.uri,
    });
    await c.unsubscribe(s.uri);
    expect(fake.subscriptions).toEqual([]);
  });

  it("names what went wrong: a bad token, a plan without webhooks, Calendly down (after retrying)", async () => {
    expect(await kind(createCalendly({ token: "nope", endpoint: fake.url }).me())).toBe("token");
    fake.freePlan = true;
    expect(
      await kind(
        c.subscribe({
          url: HOOK,
          signingKey: "k".repeat(40),
          organization: fake.organization,
          user: fake.user.uri,
        }),
      ),
    ).toBe("plan");
    fake.freePlan = false;
    fake.fail(503, 1);
    await expect(c.me()).resolves.toMatchObject({ email: "maya@business.test" });
    expect(slept).toEqual([1000]);
    fake.fail(503, 4);
    expect(await kind(c.me())).toBe("unavailable");
    expect(slept).toEqual([1000, 1000, 2000, 4000]);
  });

  it("never puts the token in an error's words", async () => {
    const e = await createCalendly({ token: "secret-token-value", endpoint: fake.url })
      .me()
      .catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain("secret-token-value");
  });
});
