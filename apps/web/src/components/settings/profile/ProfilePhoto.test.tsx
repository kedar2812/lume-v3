import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountClient } from "@/lib/settings/account";
import { fakeSession } from "@/server/session";
import { ProfilePhoto } from "./ProfilePhoto";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/settings/account", () => ({ accountClient: { setAvatar: vi.fn(), removePhoto: vi.fn() } }));

beforeEach(() => {
  vi.mocked(accountClient.setAvatar).mockReset();
  vi.mocked(accountClient.removePhoto).mockReset();
  URL.createObjectURL = vi.fn(() => "blob:photo");
  URL.revokeObjectURL = vi.fn();
});

describe("your look (7C)", () => {
  it("picks a colour for your initials, or LUME's from your name", async () => {
    vi.mocked(accountClient.setAvatar).mockResolvedValue({
      ok: true,
      status: 200,
      data: { avatar: { color: "teal", version: 1, photo: false } },
    });
    render(<ProfilePhoto session={fakeSession()} />);
    expect(screen.getByRole("radio", { name: "LUME’s pick" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Teal" }));
    expect(accountClient.setAvatar).toHaveBeenCalledWith({ color: "teal" });
    expect(screen.getByRole("radio", { name: "Teal" })).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("shows your photo, and removing it brings back your initials", async () => {
    const id = "00000000-0000-7000-8000-000000000001";
    vi.mocked(accountClient.removePhoto).mockResolvedValue({
      ok: true,
      status: 200,
      data: { avatar: { color: null, version: 4, photo: false } },
    });
    const session = fakeSession();
    session.user.avatar = { color: null, version: 3, photo: true };
    const { container } = render(<ProfilePhoto session={session} />);
    expect(container.querySelector("img")).toHaveAttribute("src", `/api/v1/users/${id}/avatar?v=3`);
    await userEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Your initials show instead");
    expect(screen.getByRole("button", { name: "Choose a photo…" })).toBeInTheDocument();
  });

  it("a chosen photo opens the cropper on the full-window scrim; files that aren't photos are refused in words", async () => {
    const { container } = render(<ProfilePhoto session={fakeSession()} />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, new File(["%PDF"], "cv.pdf", { type: "application/pdf" }), {
      applyAccept: false,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a photo");
    await userEvent.upload(input, new File([new Uint8Array(8)], "me.jpg", { type: "image/jpeg" }));
    const dialog = screen.getByRole("dialog", { name: "Line up your photo" });
    expect(dialog.closest("[data-scrim]")?.parentElement).toBe(document.body);
    expect(screen.getByRole("slider", { name: "Zoom" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
