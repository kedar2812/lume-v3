import { DEFAULT_AI_PROFILE } from "@lume/core/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiClient } from "@/lib/ai/client";
import type { AiProfileView, AiStatus } from "@/lib/ai/types";
import { AiSettings } from "./AiSettings";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
vi.mock("@/lib/ai/client", () => ({ aiClient: { saveProfile: vi.fn(), askTopUp: vi.fn() } }));
vi.mock("@/components/media/MediaPicker", () => ({
  MediaPicker: ({ onPick }: { onPick(f: { id: string; name: string }[]): void }) => (
    <button onClick={() => onPick([{ id: F3, name: "Past work.pdf" }])}>pick Past work</button>
  ),
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const F1 = "0192b000-0000-7000-8000-0000000000f1";
const F2 = "0192b000-0000-7000-8000-0000000000f2";
const F3 = "0192b000-0000-7000-8000-0000000000f3";

const view = (o: Partial<AiProfileView> = {}): AiProfileView => ({
  profile: { ...DEFAULT_AI_PROFILE, knows: { ...DEFAULT_AI_PROFILE.knows, files: [F1, F2] } },
  currency: "INR",
  stages: [{ id: "s1", name: "Site visit booked", pipeline: "Sales" }],
  files: [
    { id: F1, name: "Brochure.pdf", archived: false },
    { id: F2, name: "Old rates.pdf", archived: true },
  ],
  speakers: [{ id: "u1", name: "Priya Nair" }],
  ...o,
});
const status: AiStatus = {
  on: true,
  hour: { used: 2, limit: 100, resetsAt: "2026-10-21T11:00:00.000Z" },
  week: { used: 0, limit: null, resetsAt: "2026-10-25T18:30:00.000Z" },
  month: { used: 300, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" },
  paused: null,
  spend: null,
  pace: { daysLeft: null },
  topUp: { asked: false },
};

beforeEach(() => vi.clearAllMocks());

/** Settings → LUME AI (Autopilot A1, Task 6). */
describe("Settings → LUME AI", () => {
  it("with LUME AI off, the page explains and links to Integrations", () => {
    render(<AiSettings initial={view()} status={{ ...status, on: false }} />);
    expect(screen.getByText(/LUME AI is off for this business/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Switch LUME AI on in Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    expect(screen.queryByRole("heading", { name: "What LUME AI knows" })).toBeNull();
  });

  it("four sections, and the month's use", () => {
    render(<AiSettings initial={view()} status={status} />);
    for (const h of ["What LUME AI knows", "Voice", "Standing choices", "Usage"])
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    expect(screen.getByText("300 of 3,000 this month")).toBeInTheDocument();
    expect(screen.getAllByText("Used by Autopilot").length).toBeGreaterThan(0);
  });

  it("a file chosen from Media shows by its thumbnail; an archived one says so with Remove", async () => {
    vi.mocked(aiClient.saveProfile).mockImplementation(async (p) =>
      ok(
        view({
          profile: { ...DEFAULT_AI_PROFILE, knows: { ...DEFAULT_AI_PROFILE.knows, files: p.knows!.files! } },
        }),
      ),
    );
    render(<AiSettings initial={view()} status={status} />);
    const files = screen.getByRole("list", { name: "Files LUME AI may send" });
    const brochure = within(files).getByRole("listitem", { name: "Brochure.pdf" });
    expect(brochure.querySelector("img")).toHaveAttribute("src", `/api/v1/files/${F1}/thumb`);
    const old = within(files).getByRole("listitem", { name: "Old rates.pdf" });
    expect(old).toHaveTextContent("Archived in Media");
    await userEvent.click(within(old).getByRole("button", { name: "Remove Old rates.pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "Choose from Media" }));
    await userEvent.click(screen.getByRole("button", { name: "pick Past work" }));
    expect(within(files).getByRole("listitem", { name: "Past work.pdf" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save what LUME AI knows" }));
    expect(aiClient.saveProfile).toHaveBeenCalledWith({
      knows: expect.objectContaining({ files: [F1, F3] }),
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("the voice sample changes with the tone", async () => {
    render(<AiSettings initial={view()} status={status} />);
    const sample = screen.getByTestId("voice-sample");
    const warm = sample.textContent;
    await userEvent.click(screen.getByRole("radio", { name: "Formal" }));
    expect(sample.textContent).not.toBe(warm);
    expect(sample).toHaveTextContent("Thank you for your enquiry");
    await userEvent.type(screen.getByRole("textbox", { name: "Sign-off" }), "Team Brightpath");
    expect(sample).toHaveTextContent("Team Brightpath");
  });

  it("a refusal from the server is said on its section", async () => {
    vi.mocked(aiClient.saveProfile).mockResolvedValue({
      ok: false,
      status: 400,
      code: "INVALID_PROFILE",
      message: "A goal is one of your open stages.",
    } as never);
    render(<AiSettings initial={view()} status={status} />);
    await userEvent.click(screen.getByRole("button", { name: /^Hands-off/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save standing choices" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A goal is one of your open stages.");
  });

  it("leaving with unsaved changes asks first", async () => {
    render(
      <>
        <a href="/leads">Leads</a>
        <AiSettings initial={view()} status={status} />
      </>,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "About your business" }), "We design homes.");
    await userEvent.click(screen.getByRole("link", { name: "Leads" }));
    expect(screen.getByRole("dialog", { name: "Leave without saving?" })).toBeInTheDocument();
  });
});
