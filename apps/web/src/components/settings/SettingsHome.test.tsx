import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeSession } from "@/server/session";
import { SettingsHome } from "./SettingsHome";

describe("SettingsHome", () => {
  it("offers a rep only their own settings", () => {
    render(<SettingsHome session={fakeSession({ permissions: [{ key: "leads.view", scope: "own" }] })} />);
    const links = screen.getAllByRole("link").map((l) => l.textContent);
    expect(links).toEqual([expect.stringMatching(/^My account/), expect.stringMatching(/^About/)]);
  });

  it("groups an admin's areas, each a link with a line about what's inside", () => {
    render(
      <SettingsHome
        session={fakeSession({
          permissions: [
            { key: "settings.manage", scope: null },
            { key: "users.manage", scope: null },
          ],
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Your workspace" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "People and access" })).toBeInTheDocument();
    const business = screen.getByRole("link", { name: /^Business/ });
    expect(business).toHaveAttribute("href", "/settings/business");
    expect(business).toHaveTextContent("Name, timezone, currency and country");
  });
});
