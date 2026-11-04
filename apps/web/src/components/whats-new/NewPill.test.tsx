import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WHATS_NEW, type StoryId, type WhatsNewState } from "@lume/core/shared";
import { DEFAULT_CALL_RULES } from "@lume/core/shared";
import { CallTimes } from "@/components/settings/ai/CallTimes";
import { TemplateLibrary } from "@/components/templates/TemplateLibrary";
import { fakeSession } from "@/server/session";
import { NewPill } from "./NewPill";
import { WhatsNewProvider } from "./WhatsNewProvider";

let path = "/today";
vi.mock("next/navigation", () => ({ usePathname: () => path, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ai/use-ai-on", () => ({ useAiOn: () => true }));
vi.mock("@/lib/templates/client", () => ({
  templatesClient: {
    whatsapp: vi.fn(async () => ({ ok: true, status: 200, data: { on: false, submissions: [] } })),
  },
}));

const save = vi.fn(async (p: { used?: StoryId }): Promise<WhatsNewState> => ({
  ...EMPTY_WHATS_NEW,
  seen: "1.2.0",
  used: p.used ? [`1.2.0:${p.used}`] : [],
}));

function sessionWith(stories: StoryId[], state: WhatsNewState = { ...EMPTY_WHATS_NEW, seen: "1.2.0" }) {
  return fakeSession({
    whatsNew: { version: "1.2.0", stories, state },
    flags: {
      needsAgreement: false,
      needsOnboarding: false,
      needsTwoFactorEnrolment: false,
      needsTour: false,
      needsWhatsNew: false,
    },
  });
}
const pills = (story: StoryId, session = sessionWith(["calls", "chats", "templates"])) =>
  render(
    <WhatsNewProvider session={session} client={{ save }}>
      <span data-testid="pill">
        <NewPill story={story} />
      </span>
    </WhatsNewProvider>,
  );
const pill = () => screen.getByTestId("pill").textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T10:00:00Z"));
  path = "/today";
  save.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("New, beside what's new", () => {
  it("shows for a story not yet used, inside the week", () => {
    pills("chats");
    expect(pill()).toBe("New");
  });

  it("not once the week is over", () => {
    vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
    pills("chats");
    expect(pill()).toBe("");
  });

  it("not once used", () => {
    pills("chats", sessionWith(["chats"], { ...EMPTY_WHATS_NEW, seen: "1.2.0", used: ["1.2.0:chats"] }));
    expect(pill()).toBe("");
  });

  it("not for a story this person can't see", () => {
    pills("calls", sessionWith(["chats", "templates"]));
    expect(pill()).toBe("");
  });

  it("opening its place counts as used; the pill stays while they're there and is gone after", async () => {
    path = "/replies";
    const view = pills("chats");
    await act(async () => undefined);
    expect(save).toHaveBeenCalledWith({ used: "chats" });
    expect(pill()).toBe("New");
    path = "/today";
    view.rerender(
      <WhatsNewProvider session={sessionWith(["calls", "chats", "templates"])} client={{ save }}>
        <span data-testid="pill">
          <NewPill story="chats" />
        </span>
      </WhatsNewProvider>,
    );
    await act(async () => undefined);
    expect(pill()).toBe("");
  });

  it("opening a place that isn't a story's saves nothing", async () => {
    path = "/leads";
    pills("chats");
    await act(async () => undefined);
    expect(save).not.toHaveBeenCalled();
  });

  it("beside the calls panel's title on Settings → LUME AI, and on Write with LUME AI", () => {
    const session = sessionWith(["calls", "templates"]);
    render(
      <WhatsNewProvider session={session} client={{ save }}>
        <CallTimes value={DEFAULT_CALL_RULES} onChange={() => undefined} />
        <TemplateLibrary initial={[]} roles={[]} fields={[]} canManage />
      </WhatsNewProvider>,
    );
    expect(screen.getByRole("heading", { name: /Calls LUME AI may say yes to/ })).toHaveTextContent("New");
    expect(screen.getByRole("button", { name: /Write with LUME AI/ })).toHaveTextContent("New");
  });
});
