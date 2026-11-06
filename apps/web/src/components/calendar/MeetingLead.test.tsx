import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import { leadsClient } from "@/lib/leads/client";
import type { Meeting } from "@/lib/calendar/types";
import { fakeSession } from "@/server/session";
import { testCatalog } from "@/lib/leads/test-catalog";
import { CalendarScreen, type CalendarScreenProps } from "./CalendarScreen";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/calendar",
}));
vi.mock("@/lib/calendar/client", () => ({ calendarClient: { meetings: vi.fn(), patchMeeting: vi.fn() } }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn() } }));
// The real form is tested on its own; here, it only says which lead it made.
vi.mock("@/components/leads/NewLeadSheet", () => ({
  NewLeadSheet: ({ onCreated }: { onCreated: (l: { id: string; name: string }) => void }) => (
    <button type="button" onClick={() => onCreated({ id: "l-new", name: "Arjun Rao" })}>
      Save the new lead
    </button>
  ),
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const call: Meeting = {
  id: "m1",
  title: "Call with Arjun",
  startsAt: "2026-10-01T10:00:00.000Z",
  endsAt: "2026-10-01T10:30:00.000Z",
  status: "scheduled",
  link: null,
  location: null,
  ownerId: "u-maya",
  matchedBy: "calendar",
  outcomeNote: null,
  lead: null,
};
function view(over: Partial<CalendarScreenProps> = {}) {
  return render(
    <CalendarScreen
      me="u-maya"
      tz="Asia/Kolkata"
      weekStart="monday"
      everyone={false}
      people={[{ id: "u-maya", name: "Maya Kapoor" }]}
      stages={[]}
      initial={{ view: "agenda", day: null, meeting: "m1" }}
      now={() => new Date("2026-10-01T08:00:00.000Z")}
      leads={{ session: fakeSession(), canCreate: true, catalog: testCatalog() }}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/calendar");
  vi.mocked(calendarClient.meetings).mockResolvedValue(ok({ meetings: [call] }) as never);
  vi.mocked(calendarClient.patchMeeting).mockResolvedValue(ok({ meeting: { ...call, lead: null } }) as never);
});

/** A client's team, 2026-11-06: "can't add a lead from the calendar call". */
describe("a call that isn't with a lead yet", () => {
  it("offers to add the person as a lead, and links the call to the lead it makes", async () => {
    view();
    const drawer = await screen.findByRole("dialog", { name: "Call with Arjun" });
    await userEvent.click(within(drawer).getByRole("button", { name: "Add as a lead" }));
    await userEvent.click(screen.getByRole("button", { name: "Save the new lead" }));
    expect(calendarClient.patchMeeting).toHaveBeenCalledWith("m1", { leadId: "l-new" });
  });

  it("links the call to a lead already in LUME, found by name, phone or email", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue(
      ok({ items: [{ id: "l-7", name: "Arjun Rao", phone: null, email: null }], nextCursor: null }) as never,
    );
    view();
    const drawer = await screen.findByRole("dialog", { name: "Call with Arjun" });
    await userEvent.click(within(drawer).getByRole("button", { name: "Link to a lead" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a lead" }), "Arjun");
    await userEvent.click(await screen.findByRole("button", { name: /Arjun Rao/ }));
    expect(vi.mocked(leadsClient.list).mock.calls.at(-1)![0]).toMatchObject({ q: "Arjun" });
    expect(calendarClient.patchMeeting).toHaveBeenCalledWith("m1", { leadId: "l-7" });
  });

  it("someone who can't add leads is offered only the link", async () => {
    view({ leads: { session: fakeSession(), canCreate: false, catalog: testCatalog() } });
    const drawer = await screen.findByRole("dialog", { name: "Call with Arjun" });
    expect(within(drawer).queryByRole("button", { name: "Add as a lead" })).toBeNull();
    expect(within(drawer).getByRole("button", { name: "Link to a lead" })).toBeInTheDocument();
  });

  it("a call already with a lead offers neither", async () => {
    vi.mocked(calendarClient.meetings).mockResolvedValue(
      ok({
        meetings: [{ ...call, lead: { id: "l-1", name: "Arjun Rao", pipelineId: "p", stageId: "s" } }],
      }) as never,
    );
    view();
    const drawer = await screen.findByRole("dialog", { name: "Call with Arjun" });
    expect(within(drawer).queryByRole("button", { name: "Add as a lead" })).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "Link to a lead" })).toBeNull();
  });
});
