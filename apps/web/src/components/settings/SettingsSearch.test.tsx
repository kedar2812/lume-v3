import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_AREAS } from "@/lib/settings/areas";
import { SettingsSearch } from "./SettingsSearch";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/settings" }));
let resolveYours: (v: unknown) => void = () => undefined;
vi.mock("@/lib/settings/yours", () => ({
  loadYours: () => new Promise((r) => (resolveYours = r)),
}));

const everyArea = SETTINGS_AREAS;
const type = (v: string) =>
  fireEvent.change(screen.getByRole("combobox", { name: "Search settings" }), { target: { value: v } });
const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  push.mockReset();
  sessionStorage.clear();
});

describe("Search settings", () => {
  it("finds a setting by a misspelling and says where it lives", () => {
    render(<SettingsSearch areas={everyArea} />);
    type("curency");
    expect(options()[0]).toBe("CurrencyBusiness");
    type("abuot");
    expect(options()).toContain("About LUMEAbout");
  });

  it("finds a setting by a word people use for it", () => {
    render(<SettingsSearch areas={everyArea} />);
    type("2fa");
    expect(options()[0]).toBe("Two-step sign-inMy account");
  });

  it("Enter opens the first one and remembers it so the page can light it up", () => {
    render(<SettingsSearch areas={everyArea} />);
    type("watermark");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/settings/security");
    expect(sessionStorage.getItem("lume:settings:find")).toBe("On-screen watermark");
  });

  it("never offers an area the person can't open", () => {
    render(<SettingsSearch areas={everyArea.filter((a) => a.group === "you")} />);
    type("watermark");
    expect(options()).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("Nothing in Settings matches “watermark”.");
  });

  it("the business's own stages and people are found once they've loaded, with a waiting row if that's slow", async () => {
    vi.useFakeTimers();
    render(<SettingsSearch areas={everyArea} />);
    type("discov");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Looking through your stages, fields and people…")).toBeTruthy();
    await act(async () => {
      resolveYours([
        {
          id: "yours:pipeline:Stage:1",
          label: "Discovery call",
          where: "Pipeline & stages · Stage",
          href: "/settings/pipeline",
          keywords: ["stage"],
          kind: "yours",
        },
      ]);
    });
    expect(options()[0]).toBe("Discovery callPipeline & stages · Stage");
    vi.useRealTimers();
  });
});
