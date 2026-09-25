import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LEGAL_VERSION } from "@lume/core/shared";
import { api } from "@/lib/api";
import { AgreementScreen } from "./AgreementScreen";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api: { post: vi.fn() } }));

// jsdom has no layout, so the "reached the end" signal is driven by hand through IntersectionObserver.
let reachEnd: () => void = () => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: IntersectionObserverCallback) {
        reachEnd = () =>
          act(() => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never));
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

const show = (props: Partial<Parameters<typeof AgreementScreen>[0]> = {}) =>
  render(<AgreementScreen agreedVersion={null} next="/welcome" {...props} />);

describe("AgreementScreen", () => {
  it("shows the licence agreement, the terms and the privacy policy in one readable place", () => {
    show();
    const docs = screen.getByRole("region", {
      name: "Licence agreement, terms of service and privacy policy",
    });
    expect(docs).toHaveAttribute("tabindex", "0"); // scrollable with the keyboard
    for (const title of ["Licence agreement", "Terms of service", "Privacy policy"])
      expect(screen.getByRole("heading", { level: 2, name: title })).toBeInTheDocument();
  });

  it("keeps I agree off until the reader reaches the end, then records the agreement and moves on", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, status: 204, data: null });
    show();
    const agree = screen.getByRole("button", { name: "I agree" });
    expect(agree).toBeDisabled();
    expect(screen.getByText("Scroll to the end to agree")).toBeInTheDocument();
    reachEnd();
    expect(agree).toBeEnabled();
    expect(screen.getByText("You’ve read to the end")).toBeInTheDocument();
    await userEvent.click(agree);
    expect(api.post).toHaveBeenCalledWith("/api/v1/me/agreement", { version: LEGAL_VERSION });
    expect(replace).toHaveBeenCalledWith("/welcome");
  });

  it("jumps to each document from its tab", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    show();
    await userEvent.click(screen.getByRole("button", { name: "Privacy policy" }));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("says when the documents have changed since the person last agreed", () => {
    show({ agreedVersion: "2020-01-01" });
    expect(screen.getByRole("heading", { level: 1, name: "We’ve updated our terms" })).toBeInTheDocument();
  });

  it("explains a change made while reading, instead of recording agreement to old words", async () => {
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      status: 409,
      code: "STALE_TERMS",
      message: "changed",
    });
    show();
    reachEnd();
    await userEvent.click(screen.getByRole("button", { name: "I agree" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "These documents changed while you were reading",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("lets the person decline, which signs them out", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, status: 204, data: null });
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    show();
    await userEvent.click(screen.getByRole("button", { name: "Decline and sign out" }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/auth/logout");
    expect(assign).toHaveBeenCalledWith("/sign-in");
  });
});
