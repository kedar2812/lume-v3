import { afterEach, describe, expect, it, vi } from "vitest";
import { graphPathSafe, igGraph } from "./graph";

/** Ids from webhooks and Meta's answers become part of a Graph address: one that would change the address never goes. */
describe("Graph addresses", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Meta's ids and words pass; a slash, dots, ? or # never do", () => {
    for (const ok of [
      "me",
      "17841400000000001",
      "17841400000000001/messages",
      "aWdfZAG06abc-_=",
      "18000/replies",
    ])
      expect(graphPathSafe(ok)).toBe(true);
    for (const bad of [
      "",
      "../me",
      "123/../../oauth",
      "123?fields=x",
      "123#x",
      "12 3",
      "%2e%2e",
      "a/",
      "x".repeat(201),
    ])
      expect(graphPathSafe(bad)).toBe(false);
  });

  it("an id that would change the address is refused without calling Meta", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const g = igGraph({ graphUrl: "https://graph.test", version: "v23.0" }, "token");
    expect(await g.profile("../me")).toMatchObject({ ok: false, status: 400 });
    expect(await g.publicReply("1/../2?x", "hi")).toMatchObject({ ok: false, status: 400 });
    expect(await g.photo("123#frag")).toMatchObject({ ok: false, status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
