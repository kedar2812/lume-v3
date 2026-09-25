import { callApi, expect, hydrated, lastMailTo, linkIn, PEOPLE, stateFile, test } from "./fixtures";

test("seed: the owner finishes onboarding, then invites an admin and two sales reps by email", async ({
  page,
  browser,
}) => {
  // The owner is signed in (storage state from the wizard). Skip through onboarding to reach the app.
  await page.goto("/welcome");
  await page.getByRole("button", { name: /let’s go/i }).click();
  // Wait for whichever button comes next rather than guessing whether a panel has finished arriving.
  const explore = page.getByRole("button", { name: /explore on my own/i });
  const skip = page.getByRole("button", { name: /^(Skip|Later)$/ });
  for (let i = 0; i < 12; i++) {
    await explore.or(skip).first().waitFor();
    if (await explore.isVisible()) break;
    await skip.click();
  }
  await explore.click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("dialog", { name: /tour/i })).toHaveCount(0); // "on my own" means no tour
  await page.context().storageState({ path: stateFile("owner") });

  const assignable = await callApi<{ roles: { id: string; name: string }[] }>(
    page,
    "GET",
    "/api/v1/roles/assignable",
  );
  expect(assignable.status, JSON.stringify(assignable.data)).toBe(200);
  const roleId = (name: string) => assignable.data.roles.find((r) => r.name === name)!.id;

  for (const who of [
    { ...PEOPLE.admin, role: "Admin", file: stateFile("admin") },
    { ...PEOPLE.rep, role: "Sales", file: stateFile("rep") },
    { ...PEOPLE.aman, role: "Sales", file: null },
    { ...PEOPLE.seller, role: "Sales", file: stateFile("seller") },
  ]) {
    const since = new Date(Date.now() - 1000).toISOString();
    const invited = await callApi(page, "POST", "/api/v1/invites", {
      email: who.email,
      name: who.name,
      roleIds: [roleId(who.role)],
    });
    expect(invited.status, JSON.stringify(invited.data)).toBe(201);

    const link = linkIn(await lastMailTo(page.request, who.email, since), "invite");
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(link);
    await hydrated(p);
    await expect(p.getByText(who.email)).toBeHidden(); // the address is in a read-only field, not text
    await expect(p.getByLabel("Email")).toHaveValue(who.email);
    await p.getByLabel("Choose a password").fill(who.password);
    await p.getByRole("button", { name: "Join LUME" }).click();
    await expect(p).toHaveURL(/\/welcome$/);
    if (who.email === PEOPLE.seller.email) {
      // Noor skips onboarding and the tour, so specs that run before onboarding.spec can use a rep.
      expect((await callApi(p, "PUT", "/api/v1/me/onboarding", { completed: true })).status).toBe(200);
      expect((await callApi(p, "PUT", "/api/v1/me/tour", { skipped: true })).status).toBe(200);
    }
    if (who.file) await ctx.storageState({ path: who.file });
    await ctx.close();

    // An invite works once.
    const again = await browser.newContext();
    const q = await again.newPage();
    await q.goto(link);
    await hydrated(q);
    await expect(q.getByText(/no longer valid/i)).toBeVisible();
    await again.close();
  }

  // Leads for the 1C-2 specs: Noor (Sales) owns four, the admin two, and two are unassigned.
  const people = (await callApi<{ people: { id: string; name: string }[] }>(page, "GET", "/api/v1/people"))
    .data.people;
  const idOf = (name: string) => people.find((p) => p.name === name)!.id;
  const leads = [
    {
      name: "Aisha Khan",
      phone: "+971501234567",
      email: "aisha@example.com",
      owner: idOf(PEOPLE.seller.name),
      value: 4500,
    },
    { name: "Omar Haddad", phone: "+971502223344", owner: idOf(PEOPLE.seller.name) },
    { name: "Sara Nasser", phone: "+971503334455", owner: idOf(PEOPLE.seller.name) },
    { name: "Priya Menon", phone: "+971504445566", owner: idOf(PEOPLE.seller.name) },
    { name: "Karim Aziz", phone: "+971505556677", owner: idOf(PEOPLE.admin.name) },
    { name: "Lina Farah", phone: "+971506667788", owner: idOf(PEOPLE.admin.name) },
    { name: "Unassigned One", phone: "+971507778899", owner: null },
    { name: "Unassigned Two", phone: "+971508889900", owner: null },
  ];
  for (const l of leads) {
    const r = await callApi(page, "POST", "/api/v1/leads", {
      name: l.name,
      phone: l.phone,
      ...(l.email ? { email: l.email } : {}),
      ownerId: l.owner,
      ...(l.value ? { value: l.value } : {}),
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
  }
  const { pipelines } = (
    await callApi<{ pipelines: { stages: { id: string; name: string }[] }[] }>(
      page,
      "GET",
      "/api/v1/pipelines",
    )
  ).data;
  const booked = pipelines[0]!.stages.find((s) => s.name === "Call booked")!;
  const { fields } = (await callApi<{ fields: { id: string; key: string }[] }>(page, "GET", "/api/v1/fields"))
    .data;
  const struggles = fields.find((f) => f.key === "struggles")!;
  const required = await callApi(page, "PATCH", `/api/v1/stages/${booked.id}`, {
    requiredFieldIds: [struggles.id],
  });
  expect(required.status, JSON.stringify(required.data)).toBe(200);
});
