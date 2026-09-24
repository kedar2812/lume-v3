import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFERENCES_DEFAULTS } from "@lume/core/shared";
import { fakeSession } from "@/server/session";
import { Onboarding, type OnboardingActions } from "./Onboarding";

// jsdom runs no animations, so AnimatePresence would wait forever for an exit before mounting the next step.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({ initial, animate, exit, transition, layout, ...rest }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    void layout,
    rest
  );
  // One component per tag, made once: a fresh type on every render would remount controlled inputs.
  const made = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        if (!made.has(tag))
          made.set(
            tag,
            forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
          );
        return made.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
    useReducedMotion: () => true,
  };
});

const actions = () =>
  ({
    saveProfile: vi.fn<OnboardingActions["saveProfile"]>(async () => true),
    savePreferences: vi.fn<OnboardingActions["savePreferences"]>(async () => true),
    markStep: vi.fn(async () => {}),
    skipStep: vi.fn(async () => {}),
    complete: vi.fn(async () => {}),
    startEnrolment: vi.fn(async () => ({
      secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      otpauthUri: "otpauth://totp/LUME",
    })),
    confirmEnrolment: vi.fn(async () => ({ ok: true as const, recoveryCodes: ["AAAAA-BBBBB"] })),
    listPeople: vi.fn(async () => [
      { id: "u9", name: "Nupuur Patil", email: "n@x.com", role: "Owner", pending: false },
    ]),
    listRoles: vi.fn(async () => [
      { id: "r-admin", name: "Admin" },
      { id: "r-sales", name: "Sales" },
    ]),
    invite: vi.fn(async () => ({ ok: true })),
    listPipeline: vi.fn(async () => ({
      id: "p1",
      name: "Coaching sales",
      stages: [
        { id: "s1", name: "New", kind: "open", color: "accent" },
        { id: "s2", name: "Won", kind: "won", color: "ok" },
        { id: "s3", name: "Lost", kind: "lost", color: "danger" },
      ],
    })),
    renameStage: vi.fn(async () => true),
    reorderStages: vi.fn(async () => true),
  }) satisfies OnboardingActions;

const rep = () =>
  fakeSession({
    user: {
      id: "u1",
      name: "Riya Sharma",
      email: "riya@x.com",
      isOwner: false,
      theme: "system",
      timezone: null,
    },
    permissions: [{ key: "leads.view", scope: "own" }],
    preferences: PREFERENCES_DEFAULTS,
  });

const owner = (caps = { sheets: false, calendar: false }) =>
  fakeSession({
    user: {
      id: "u3",
      name: "Nupuur Patil",
      email: "n@x.com",
      isOwner: true,
      theme: "system",
      timezone: null,
    },
    permissions: [],
    twoFactor: { enabled: true, required: true },
    capabilities: caps,
  });

const typeCode = async (code: string) => {
  const first = await screen.findByLabelText("Digit 1 of 6");
  first.focus();
  await userEvent.keyboard(code);
};
const railLabels = () =>
  within(screen.getByRole("navigation", { name: /steps/i }))
    .getAllByRole("button")
    .map((b) => b.textContent?.replace("Required", "").trim());

beforeEach(() => {
  vi.restoreAllMocks();
  document.documentElement.dataset.theme = "system";
});

describe("Onboarding", () => {
  it("shows a rep the personal steps only, and the app stays visible behind", async () => {
    render(<Onboarding session={rep()} actions={actions()} onFinished={() => {}} />);
    expect(railLabels()).toEqual(["Welcome", "You", "Look", "Your day", "Alerts", "All set"]);
    expect(screen.getByRole("dialog", { name: /welcome to lume/i })).toBeInTheDocument();
  });

  it("saves the name and timezone, then records the step", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.clear(screen.getByLabelText("Your name"));
    await userEvent.type(screen.getByLabelText("Your name"), "Riya S");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Riya S" }));
    expect(a.saveProfile.mock.calls[0]![0]).toHaveProperty("timezone", expect.any(String));
    expect(a.markStep).toHaveBeenCalledWith("look");
  });

  it("keeps the person on the step, with the reason, when saving fails", async () => {
    const a = { ...actions(), saveProfile: vi.fn(async () => false) };
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t save/i);
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
    expect(a.markStep).not.toHaveBeenCalledWith("look"); // still on You
  });

  it("records a skipped step and moves on", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(a.skipStep).toHaveBeenCalledWith("you");
    expect(await screen.findByRole("radiogroup", { name: /theme/i })).toBeInTheDocument();
  });

  it("previews the theme live and saves the choice", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("radio", { name: /obsidian/i }));
    expect(document.documentElement.dataset.theme).toBe("obsidian");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ theme: "obsidian" }));
  });

  it("puts the old theme back when the look step is skipped after a preview", async () => {
    render(<Onboarding session={rep()} actions={actions()} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(screen.getByRole("radio", { name: /obsidian/i }));
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(document.documentElement.dataset.theme).toBe("system");
  });

  it("turns working days and times into one plain sentence, and saves them", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    for (const label of [/let’s go/i, /^Continue$/, /^Continue$/])
      await userEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByTestId("day-preview")).toHaveTextContent(/Monday to Friday/);
    await userEvent.click(screen.getByRole("button", { name: "Sat" }));
    expect(screen.getByTestId("day-preview")).toHaveTextContent(/Mon, Tue, Wed, Thu, Fri, Sat/);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.savePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ workingDays: [1, 2, 3, 4, 5, 6], workStart: "09:00", digestTime: "08:00" }),
    );
  });

  it("saves the sound and alert choices", async () => {
    const a = actions();
    render(<Onboarding session={rep()} actions={a} onFinished={() => {}} />);
    for (const label of [/let’s go/i, /^Continue$/, /^Continue$/, /^Continue$/])
      await userEvent.click(screen.getByRole("button", { name: label }));
    await userEvent.click(screen.getByRole("switch", { name: /email me the morning digest/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.savePreferences).toHaveBeenLastCalledWith({
      sounds: { enabled: true, volume: 60 },
      alerts: { assigned: true, dueFollowUps: true, emailDigest: false },
    });
  });

  it("finishes by completing onboarding and handing over to the tour", async () => {
    const a = actions();
    const onFinished = vi.fn();
    render(<Onboarding session={rep()} actions={a} onFinished={onFinished} />);
    for (const label of [/let’s go/i, /^Continue$/, /^Continue$/, /^Continue$/, /^Continue$/]) {
      await userEvent.click(screen.getByRole("button", { name: label }));
    }
    await userEvent.click(screen.getByRole("button", { name: /take the tour/i }));
    expect(a.complete).toHaveBeenCalled();
    expect(onFinished).toHaveBeenCalledWith({ startTour: true });
  });

  it("makes an admin enrol in two-step sign-in before anything past it", async () => {
    const a = actions();
    const admin = fakeSession({
      user: {
        id: "u2",
        name: "Tasneem Shaikh",
        email: "t@x.com",
        isOwner: false,
        theme: "system",
        timezone: null,
      },
      permissions: [{ key: "users.manage", scope: null }],
      twoFactor: { enabled: false, required: true },
      flags: { needsOnboarding: true, needsTwoFactorEnrolment: true, needsTour: true },
    });
    render(<Onboarding session={admin} actions={a} onFinished={() => {}} />);
    expect(railLabels()).toEqual([
      "Welcome",
      "You",
      "Secure account",
      "Look",
      "Your day",
      "Alerts",
      "Your team",
      "All set",
    ]);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // past You
    expect(await screen.findByRole("heading", { name: "Secure your account" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    // Nothing after a required step can be reached from the rail until it is done.
    const rail = within(screen.getByRole("navigation", { name: /steps/i }));
    expect(rail.getByRole("button", { name: "Look" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
    await typeCode("123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(a.confirmEnrolment).toHaveBeenCalledWith("123456");
    expect(await screen.findByText("AAAAA-BBBBB")).toBeInTheDocument(); // recovery codes, once
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled(); // until they're saved
    await userEvent.click(screen.getByRole("checkbox", { name: /saved/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(a.markStep).toHaveBeenCalledWith("look");
  });

  it("explains a wrong enrolment code and lets the person try again", async () => {
    const a = {
      ...actions(),
      confirmEnrolment: vi.fn(async () => ({ ok: false as const, message: "That code didn’t work" })),
    };
    const admin = fakeSession({
      user: {
        id: "u2",
        name: "Tasneem Shaikh",
        email: "t@x.com",
        isOwner: false,
        theme: "system",
        timezone: null,
      },
      permissions: [{ key: "users.manage", scope: null }],
      twoFactor: { enabled: false, required: true },
    });
    render(<Onboarding session={admin} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typeCode("000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn’t work/);
    expect(screen.getByLabelText("Digit 1 of 6")).toHaveValue("");
  });

  it("lets an owner invite the team and shows who is already there", async () => {
    const a = actions();
    render(<Onboarding session={owner()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    for (let i = 0; i < 4; i++) await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Nupuur Patil")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Email"), "riya@nupuur.com");
    expect(screen.getByLabelText("Name")).toHaveValue("Riya");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(a.invite).toHaveBeenCalledWith("riya@nupuur.com", "Riya", "r-sales");
    expect(await screen.findByText(/invite sent/i)).toBeInTheDocument();
  });

  it("lets an owner rename and reorder pipeline stages in place", async () => {
    const a = actions();
    render(<Onboarding session={owner()} actions={a} onFinished={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /let’s go/i }));
    for (let i = 0; i < 5; i++) await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    const name = await screen.findByDisplayValue("New");
    await userEvent.clear(name);
    await userEvent.type(name, "Fresh{Tab}");
    expect(a.renameStage).toHaveBeenCalledWith("s1", "Fresh");
    await userEvent.click(screen.getByRole("button", { name: "Move Won up" }));
    expect(a.reorderStages).toHaveBeenCalledWith("p1", ["s2", "s1", "s3"]);
  });

  it("hides Connect until an integration exists, and shows both cards when they do", async () => {
    const a = actions();
    const { unmount } = render(<Onboarding session={owner()} actions={a} onFinished={() => {}} />);
    expect(
      within(screen.getByRole("navigation", { name: /steps/i })).queryByText("Connect"),
    ).not.toBeInTheDocument();
    unmount();
    render(
      <Onboarding session={owner({ sheets: true, calendar: true })} actions={a} onFinished={() => {}} />,
    );
    expect(
      within(screen.getByRole("navigation", { name: /steps/i })).getByText("Connect"),
    ).toBeInTheDocument();
  });

  it("resumes at the step it was left on", async () => {
    const s = rep();
    render(
      <Onboarding
        session={{ ...s, onboarding: { step: "day", skipped: [], completedAt: null } }}
        actions={actions()}
        onFinished={() => {}}
      />,
    );
    expect(await screen.findByTestId("day-preview")).toBeInTheDocument();
  });
});
