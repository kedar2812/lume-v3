import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { ExportAll } from "./ExportAll";

vi.mock("@/lib/api", () => ({ api: { post: vi.fn() } }));

describe("Export all data, the small button (bug hunt 2026-11-17)", () => {
  it("a refusal says why beside it, not only Try the export again", async () => {
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "x",
    } as never);
    render(<ExportAll variant="secondary" />);
    await userEvent.click(screen.getByRole("button", { name: "Export all data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Exporting everything isn't part of your role.",
    );
    expect(screen.getByRole("button", { name: "Try the export again" })).toBeInTheDocument();
  });
});
