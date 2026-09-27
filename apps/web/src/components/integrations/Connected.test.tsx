import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import { Connected } from "./Connected";

const search = new URLSearchParams({ p: "sealed", s: "sig" });
vi.mock("next/navigation", () => ({
  useSearchParams: () => search,
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { complete: vi.fn(), connect: vi.fn() } }));
vi.mock("@/components/sheets/AddSheetSheet", () => ({
  AddSheetSheet: ({ open, connect }: { open: boolean; connect?: { file: { name: string } } }) =>
    open ? (
      <div role="dialog" aria-label="Add a sheet">
        {connect?.file.name}
      </div>
    ) : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
beforeEach(() => vi.clearAllMocks());

describe("back from Google", () => {
  it("completes the hand-back and opens Add a sheet on the picked file", async () => {
    vi.mocked(sheetsClient.complete).mockResolvedValue(
      ok({ connectId: "c1", file: { id: "f", name: "Picked leads" } }),
    );
    render(<Connected />);
    expect(sheetsClient.complete).toHaveBeenCalledWith({ p: "sealed", s: "sig" });
    expect(await screen.findByRole("dialog", { name: "Add a sheet" })).toHaveTextContent("Picked leads");
  });
  it("says what went wrong, with a way to try again", async () => {
    vi.mocked(sheetsClient.complete).mockResolvedValue({
      ok: false,
      status: 400,
      code: "CONNECT_EXPIRED",
      message: "This connection took too long. Try Connect with Google again.",
    } as never);
    render(<Connected />);
    expect(await screen.findByRole("alert")).toHaveTextContent("took too long");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
