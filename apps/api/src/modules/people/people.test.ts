import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("people", () => {
  it("gives anyone who works leads the names of everyone, disabled people marked, and nothing else", async () => {
    const seller = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Riya" });
    const gone = await h.seedUser({ grants: [], name: "Old Rep", status: "disabled" });
    const pending = await h.seedUser({ grants: [], name: "Not Yet", status: "invited" });
    const c = await h.signIn(seller);
    const res = await c.inject({ method: "GET", url: "/api/v1/people" });
    expect(res.statusCode).toBe(200);
    const people = res.json().people as { id: string; name: string; active: boolean }[];
    expect(people.find((p) => p.id === seller.id)).toEqual({ id: seller.id, name: "Riya", active: true });
    expect(people.find((p) => p.id === gone.id)?.active).toBe(false);
    expect(people.find((p) => p.id === pending.id)).toBeUndefined(); // hasn't joined yet
    expect(Object.keys(people[0]!).sort()).toEqual(["active", "id", "name"]); // no emails, no roles
  });

  it("is refused to someone who can't see leads", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/people" })).statusCode).toBe(403);
  });
});
