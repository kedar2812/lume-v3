import { callApi, expect, hydrated, lastMailTo, linkIn, PEOPLE, stateFile, test } from "./fixtures";

test("seed: the owner finishes onboarding, then invites an admin and two sales reps by email", async ({
  page,
  browser,
}) => {
  // The owner is signed in (storage state from the wizard). Skip through onboarding to reach the app.
  await page.goto("/welcome");
  await page.getByRole("button", { name: /let’s go/i }).click();
  const explore = page.getByRole("button", { name: /explore on my own/i });
  for (let i = 0; i < 12 && !(await explore.isVisible()); i++)
    await page.getByRole("button", { name: /^(Skip|Later)$/ }).click();
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
});
