import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { teamsClient } from "@/lib/settings/teams";
import { TeamsAdmin } from "./TeamsAdmin";

vi.mock("@/lib/settings/teams", () => ({
  teamsClient: { create: vi.fn(), rename: vi.fn(), remove: vi.fn(), setMembers: vi.fn() },
}));

const people = testCatalog().people;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(teamsClient.setMembers).mockImplementation(async (id, members) => ({
    ok: true,
    status: 200,
    data: { team: { id, name: "Dubai", members } },
  }));
  vi.mocked(teamsClient.remove).mockResolvedValue({ ok: true, status: 204, data: null });
});

describe("TeamsAdmin", () => {
  it("creates a team, sets its members and lead, and asks before deleting it", async () => {
    vi.mocked(teamsClient.create).mockResolvedValue({
      ok: true,
      status: 201,
      data: { team: { id: "t1", name: "Dubai", members: [] } },
    });
    render(<TeamsAdmin teams={[]} people={people} />);
    await userEvent.type(screen.getByRole("textbox", { name: "New team" }), "Dubai{Enter}");
    expect(teamsClient.create).toHaveBeenCalledWith("Dubai");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Riya Sharma in Dubai" }));
    expect(teamsClient.setMembers).toHaveBeenLastCalledWith("t1", [{ userId: "u-riya", isLead: false }]);
    await userEvent.click(screen.getByRole("radio", { name: "Riya Sharma leads Dubai" }));
    expect(teamsClient.setMembers).toHaveBeenLastCalledWith("t1", [{ userId: "u-riya", isLead: true }]);
    await userEvent.click(screen.getByRole("button", { name: "Delete Dubai" }));
    expect(teamsClient.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    expect(teamsClient.remove).toHaveBeenCalledWith("t1");
    expect(screen.queryByRole("checkbox", { name: "Riya Sharma in Dubai" })).not.toBeInTheDocument();
  });

  it("only members can lead, and removing the lead clears it", async () => {
    render(
      <TeamsAdmin
        teams={[{ id: "t1", name: "Dubai", members: [{ userId: "u-riya", isLead: true }] }]}
        people={people}
      />,
    );
    expect(screen.getByRole("radio", { name: "Tasneem Shaikh leads Dubai" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Riya Sharma in Dubai" }));
    expect(teamsClient.setMembers).toHaveBeenLastCalledWith("t1", []);
  });

  it("puts a membership back and says why when a save is refused", async () => {
    vi.mocked(teamsClient.setMembers).mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "UNKNOWN_USER",
      message: "One of those people doesn't exist",
    });
    render(<TeamsAdmin teams={[{ id: "t1", name: "Dubai", members: [] }]} people={people} />);
    const box = screen.getByRole("checkbox", { name: "Riya Sharma in Dubai" });
    await userEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveTextContent("One of those people doesn't exist");
    expect(box).not.toBeChecked();
  });
});
