import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

/** 6C review fix: "Failed sign-ins today" names someone only when every failure is theirs (its own database). */
let h: Harness;
let admin: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" }));
});
afterAll(() => h.close());

const failures = (entityIds: (string | null)[]) =>
  h.ownerPool.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
     SELECT NULL, 'user.login.failed', 'user', e, now() FROM unnest($1::text[]) e`,
    [entityIds],
  );
const failed = async () =>
  (await admin.inject({ method: "GET", url: "/api/v1/security/activity" })).json().today.failedSignIns;

describe("Failed sign-ins today (6C review)", () => {
  it("names the one person whose failures they all are, and nobody once an unknown email failed too", async () => {
    const kim = await h.seedUser({ name: "Kim Park" });
    await failures([kim.id, kim.id]);
    expect(await failed()).toMatchObject({ count: 2, name: "Kim Park" });
    await failures([null]);
    expect(await failed()).toMatchObject({ count: 3, name: null });
  });
});
