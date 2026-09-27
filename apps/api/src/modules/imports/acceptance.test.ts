import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

/** 500 rows: 400 distinct people, 100 repeats in other formats; phones local, international, 00-prefixed, spaced, scientific, blank. */
function messyFile(): { text: string; expect: { distinct: number; statuses: Record<string, number> } } {
  const rows: string[] = [];
  const status: Record<string, number> = { valid: 0, invalid: 0, missing: 0 };
  for (let i = 0; i < 400; i++) {
    const national = `50${String(1000000 + i * 7).slice(-7)}`; // 050 xxx xxxx: a real UAE mobile range
    const forms = [
      `0${national}`,
      `+971 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`,
      `00971${national}`,
      `+971${national}`,
    ];
    const phone = i % 50 === 0 ? "" : i % 97 === 0 ? "9.71501E+11" : forms[i % forms.length]!;
    rows.push(`Person ${i},${phone},p${i}@example.test`);
    if (i % 50 === 0) status.missing!++;
    else if (i % 97 === 0) status.invalid!++;
    else status.valid!++;
  }
  for (let i = 0; i < 100; i++) rows.push(`Person ${i} again,,P${i}@EXAMPLE.test`); // repeats by email, other case
  return { text: `Name,Phone,Email\n${rows.join("\n")}\n`, expect: { distinct: 400, statuses: status } };
}

it("spec §11: a 500-row messy sheet imports with zero duplicates and correct phone statuses; a re-import and a shuffled copy create nothing", async () => {
  const { text, expect: want } = messyFile();
  const run = async (body: string) => {
    const d = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/imports",
        payload: Buffer.from(body),
        headers: { "content-type": "application/octet-stream", "x-file-name": "messy.csv" },
      })
    ).json();
    expect((await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/start` })).statusCode).toBe(
      200,
    );
    await h.runImports();
    return (await h.pool.query("SELECT status, created, merged, errors FROM imports WHERE id = $1", [d.id]))
      .rows[0];
  };
  expect(await run(text)).toMatchObject({ status: "done", created: 400, merged: 100, errors: 0 });
  const counts = await h.queryAll<{ phone_status: string; n: number }>(
    "SELECT phone_status, count(*)::int AS n FROM leads WHERE name LIKE 'Person %' GROUP BY 1",
  );
  expect(Object.fromEntries(counts.map((r) => [r.phone_status, r.n]))).toEqual(want.statuses);
  expect(await run(text)).toMatchObject({ created: 0, merged: 500 });
  const [head, ...body] = text.trim().split("\n");
  const shuffled = [
    head,
    ...body
      .map((l, i) => ({ l, k: (i * 7919) % body.length }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.l),
  ].join("\n");
  expect(await run(`${shuffled}\n`)).toMatchObject({ created: 0 });
  const [total] = await h.queryAll<{ n: number }>(
    "SELECT count(*)::int AS n FROM leads WHERE name LIKE 'Person %'",
  );
  expect(total!.n).toBe(want.distinct);
}, 240_000);
