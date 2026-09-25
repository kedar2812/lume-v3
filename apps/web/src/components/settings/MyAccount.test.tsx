import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountClient } from "@/lib/settings/account";
import { fakeSession } from "@/server/session";
import { MyAccount } from "./MyAccount";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/settings/account", () => ({
  accountClient: {
    sessions: vi.fn(),
    endSession: vi.fn(),
    updateProfile: vi.fn(),
    beginTwoFactor: vi.fn(),
    confirmTwoFactor: vi.fn(),
    disableTwoFactor: vi.fn(),
    newRecoveryCodes: vi.fn(),
  },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountClient.sessions).mockResolvedValue(
    ok({
      sessions: [
        {
          id: "s1",
          current: true,
          ip: "10.0.0.1",
          userAgent: CHROME_WIN,
          createdAt: "2026-09-20T10:00:00Z",
          lastSeenAt: "2026-09-25T10:00:00Z",
        },
        {
          id: "s2",
          current: false,
          ip: "10.0.0.2",
          userAgent: SAFARI_IPHONE,
          createdAt: "2026-09-21T10:00:00Z",
          lastSeenAt: "2026-09-24T08:00:00Z",
        },
      ],
    }),
  );
  vi.mocked(accountClient.endSession).mockResolvedValue(ok(null));
});

describe("MyAccount", () => {
  it("lists my sessions with this one marked, and ends the others", async () => {
    render(<MyAccount session={fakeSession()} />);
    expect(await screen.findByText("This device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End session on Chrome · Windows" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "End session on Safari · iPhone" }));
    expect(accountClient.endSession).toHaveBeenCalledWith("s2");
    expect(screen.queryByText("Safari · iPhone")).not.toBeInTheDocument();
  });

  it("regenerates recovery codes only after confirming with the password, and shows them once", async () => {
    vi.mocked(accountClient.newRecoveryCodes).mockResolvedValue(
      ok({ recoveryCodes: ["AAAA-BBBB", "CCCC-DDDD"] }),
    );
    render(<MyAccount session={fakeSession()} />);
    await userEvent.click(await screen.findByRole("button", { name: "New recovery codes" }));
    expect(accountClient.newRecoveryCodes).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Your password"), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Replace my codes" }));
    expect(accountClient.newRecoveryCodes).toHaveBeenCalledWith("correct horse");
    expect(await screen.findByText("AAAA-BBBB")).toBeInTheDocument();
    expect(screen.getByText("The old codes stop working now.")).toBeInTheDocument();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "I’ve saved these somewhere safe" }));
    await userEvent.click(done);
    expect(screen.queryByText("AAAA-BBBB")).not.toBeInTheDocument();
  });

  it("says so when the password is wrong", async () => {
    vi.mocked(accountClient.newRecoveryCodes).mockResolvedValue({
      ok: false,
      status: 400,
      code: "WRONG_PASSWORD",
      message: "That password isn’t right",
    });
    render(<MyAccount session={fakeSession()} />);
    await userEvent.click(await screen.findByRole("button", { name: "New recovery codes" }));
    await userEvent.type(screen.getByLabelText("Your password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Replace my codes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That password isn’t right");
  });

  it("can't turn two-step sign-in off when the role requires it", async () => {
    render(<MyAccount session={fakeSession({ twoFactor: { enabled: true, required: true } })} />);
    const block = await screen.findByRole("region", { name: "Two-step sign-in" });
    expect(within(block).getByText(/Your role requires it/)).toBeInTheDocument();
    expect(within(block).queryByRole("button", { name: "Turn off" })).not.toBeInTheDocument();
  });

  it("turns two-step sign-in on with a scanned code, then shows the recovery codes", async () => {
    vi.mocked(accountClient.beginTwoFactor).mockResolvedValue(
      ok({ secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/LUME?secret=JBSWY3DPEHPK3PXP" }),
    );
    vi.mocked(accountClient.confirmTwoFactor).mockResolvedValue(ok({ recoveryCodes: ["EEEE-FFFF"] }));
    render(<MyAccount session={fakeSession({ twoFactor: { enabled: false, required: false } })} />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Digit 1 of 6"));
    await userEvent.keyboard("123456");
    expect(accountClient.confirmTwoFactor).toHaveBeenCalledWith("123456");
    expect(await screen.findByText("EEEE-FFFF")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("saves my name", async () => {
    vi.mocked(accountClient.updateProfile).mockResolvedValue(ok(null));
    render(<MyAccount session={fakeSession()} />);
    const name = screen.getByLabelText("Your name");
    await userEvent.clear(name);
    await userEvent.type(name, "Riya S{Enter}");
    expect(accountClient.updateProfile).toHaveBeenCalledWith({ name: "Riya S" });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });
});
