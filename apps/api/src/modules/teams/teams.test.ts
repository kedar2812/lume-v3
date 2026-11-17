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

describe("your own team (decided 2026-11-17)", () => {
  it("someone who manages teams can't add themselves to a team or make themselves its lead; the owner can", async () => {
    const mgr = await h.seedUser({
      grants: [
        { key: "teams.manage", scope: null },
        { key: "leads.view", scope: "team" },
      ],
    });
    const c = await h.signIn(mgr);
    const rep = await h.seedUser({ grants: [] });
    const team = (
      await c.inject({ method: "POST", url: "/api/v1/teams", payload: { name: "Abu Dhabi" } })
    ).json().team;
    const put = (members: { userId: string; isLead: boolean }[], as = c) =>
      as.inject({ method: "PUT", url: `/api/v1/teams/${team.id}/members`, payload: { members } });
    expect((await put([{ userId: rep.id, isLead: false }])).statusCode).toBe(200);
    const self = await put([
      { userId: rep.id, isLead: false },
      { userId: mgr.id, isLead: true },
    ]);
    expect(self.statusCode).toBe(403);
    expect(self.json().error.code).toBe("OWN_TEAMS");
    const owner = await h.signIn(await h.seedUser({ owner: true, grants: [], totp: true }));
    expect(
      (
        await put(
          [
            { userId: rep.id, isLead: false },
            { userId: mgr.id, isLead: true },
          ],
          owner,
        )
      ).statusCode,
    ).toBe(200);
  });

  it("the lead of a team, with teams.manage only, can't add people to it: they'd see those people's leads (review 2026-11-17)", async () => {
    const mgr = await h.seedUser({
      grants: [
        { key: "teams.manage", scope: null },
        { key: "leads.view", scope: "team" },
      ],
    });
    // Made its lead by someone who manages security (one owner per install, and an earlier test seeded it).
    const owner = await h.signIn(
      await h.seedUser({
        grants: [
          { key: "teams.manage", scope: null },
          { key: "security.manage", scope: null },
        ],
        totp: true,
      }),
    );
    const team = (
      await owner.inject({ method: "POST", url: "/api/v1/teams", payload: { name: "Sharjah" } })
    ).json().team;
    await owner.inject({
      method: "PUT",
      url: `/api/v1/teams/${team.id}/members`,
      payload: { members: [{ userId: mgr.id, isLead: true }] },
    });
    const star = await h.seedUser({ grants: [] });
    const c = await h.signIn(mgr);
    const add = await c.inject({
      method: "PUT",
      url: `/api/v1/teams/${team.id}/members`,
      payload: {
        members: [
          { userId: mgr.id, isLead: true },
          { userId: star.id, isLead: false },
        ],
      },
    });
    expect(add.statusCode).toBe(403);
    expect(add.json().error.code).toBe("OWN_TEAMS");
  });
});
