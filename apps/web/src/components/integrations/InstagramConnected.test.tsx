import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { instagramClient } from "@/lib/instagram/client";
import { InstagramConnected } from "./InstagramConnected";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/instagram/client", () => ({ instagramClient: { complete: vi.fn() } }));

const account = (id: string, username: string, connectedAt: string) => ({
  id,
  username,
  name: null,
  photo: null,
  owner: null,
  status: "active" as const,
  problem: null,
  newDmCreatesLead: true,
  newDms: "team" as const,
  limits: { newLeadsPerHour: 200, mediaMbPerPersonDay: 50, mediaMbPerDay: 2000 },
  sourceId: null,
  connectedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  search = "p=sealed&s=sig";
  window.history.replaceState(null, "", "/settings/integrations/instagram/connected?p=sealed&s=sig");
});

describe("coming back from Instagram (plan 2026-11-25-instagram-screens D1)", () => {
  it("finishes once, even when React runs its effects twice, and leaves no hand-back in the address", async () => {
    vi.mocked(instagramClient.complete).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        accounts: [
          account("a1", "older.one", "2026-11-01T00:00:00.000Z"),
          account("a2", "harbour.studio", "2026-11-25T09:00:00.000Z"),
        ],
      },
    });
    render(
      <StrictMode>
        <InstagramConnected />
      </StrictMode>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Finishing connecting your Instagram account");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings/integrations#instagram"));
    expect(instagramClient.complete).toHaveBeenCalledTimes(1);
    expect(instagramClient.complete).toHaveBeenCalledWith({ p: "sealed", s: "sig" });
    expect(window.location.search).toBe("");
    // The newest account is the one just connected.
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "ok", title: "Instagram connected", detail: "@harbour.studio" }),
    );
  });

  it("a hand-back that took too long says so, and how to start again", async () => {
    vi.mocked(instagramClient.complete).mockResolvedValue({
      ok: false,
      status: 400,
      code: "CONNECT_EXPIRED",
      message: "This connection took too long. Try connecting the account again.",
    } as never);
    render(<InstagramConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("took too long");
    expect(screen.getByRole("link", { name: "Back to Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations#instagram",
    );
    expect(window.location.search).toBe("");
    expect(replace).not.toHaveBeenCalled();
  });

  it("a hand-back already used (a refresh, or a second tab) says so and finishes nothing", async () => {
    vi.mocked(instagramClient.complete).mockResolvedValue({
      ok: false,
      status: 404,
      code: "CONNECT_NOT_FOUND",
      message: "This connection was already used, or isn't yours. Try again.",
    } as never);
    render(<InstagramConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("already used");
    expect(toast).not.toHaveBeenCalled();
  });

  it("no hand-back at all: says where connecting starts, and asks the server nothing", async () => {
    search = "";
    render(<InstagramConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Start from Settings → Integrations → Instagram",
    );
    expect(instagramClient.complete).not.toHaveBeenCalled();
  });

  it("a lost connection on the way says to check it, and the link back works", async () => {
    vi.mocked(instagramClient.complete).mockResolvedValue({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "LUME couldn't reach the server. Check your connection.",
    } as never);
    render(<InstagramConnected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your connection");
  });
});
