import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("teams drive team scope", () => {
  it("a team lead's actor includes every member of teams they lead", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "teams.manage", scope: null }] }));
    const lead = await h.seedUser({ grants: [{ key: "leads.view", scope: "team" }] });
    const m1 = await h.seedUser({ grants: [] });
    const m2 = await h.seedUser({ grants: [] });
    const team = (
      await admin.inject({ method: "POST", url: "/api/v1/teams", payload: { name: "Dubai" } })
    ).json().team;
    const put = await admin.inject({
      method: "PUT",
      url: `/api/v1/teams/${team.id}/members`,
      payload: {
        members: [
          { userId: lead.id, isLead: true },
          { userId: m1.id, isLead: false },
          { userId: m2.id, isLead: false },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    await h.waitForRbacNotify();
    const me = await h.actorOf(lead.id); // harness: loadActor through the app's cache
    expect([...me!.teamMemberIds].sort()).toEqual([lead.id, m1.id, m2.id].sort());
  });
});
