import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { MessagingSettings } from "./MessagingSettings";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => vi.clearAllMocks());

describe("Settings → Messages (4C Task 1)", () => {
  it("the run size and the daily limit, saved together", async () => {
    vi.mocked(api.put).mockResolvedValue(ok({ queueSize: 80, dailyCap: 150 }));
    render(<MessagingSettings initial={{ queueSize: 50, dailyCap: 150 }} />);
    const size = screen.getByLabelText("Leads in a run");
    await userEvent.clear(size);
    await userEvent.type(size, "80");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).toHaveBeenCalledWith("/api/v1/settings/messaging", { queueSize: 80, dailyCap: 150 });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("says what's wrong in LUME's words before asking the server", async () => {
    render(<MessagingSettings initial={{ queueSize: 50, dailyCap: 150 }} />);
    const cap = screen.getByLabelText("Queued messages a person may send a day");
    await userEvent.clear(cap);
    await userEvent.type(cap, "900");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a daily limit between 1 and 500.");
  });
});
