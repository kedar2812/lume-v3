import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEMOS } from ".";
import { CallsDemo } from "./CallsDemo";
import { ChatsDemo } from "./ChatsDemo";
import { TemplatesDemo } from "./TemplatesDemo";

/** Still (reduced motion, or a story that isn't playing): each demo shows its finished frame, every word there. */
describe("the stories' demos, still", () => {
  it("every story has its demo", () => {
    expect(DEMOS.calls).toBe(CallsDemo);
    expect(DEMOS.chats).toBe(ChatsDemo);
    expect(DEMOS.templates).toBe(TemplatesDemo);
  });

  it("calls: the lead asks, LUME AI says yes with the Meet link, and the call is in the Calendar", () => {
    render(<CallsDemo playing={false} />);
    expect(screen.getByText("Can we talk Thursday at 5?")).toBeInTheDocument();
    expect(screen.getByText(/meet\.google\.com/)).toBeInTheDocument();
    expect(screen.getByText(/Thursday, 5:00 PM/)).toBeInTheDocument();
    expect(screen.getByText("Call with Arjun")).toBeInTheDocument();
  });

  it("chats: the messages are there, and the notice in the corner", () => {
    render(<ChatsDemo playing={false} />);
    const notice = screen.getByRole("status");
    expect(within(notice).getByText("Arjun Rao")).toBeInTheDocument();
    expect(within(notice).getByText("What are your timings on Saturday?")).toBeInTheDocument();
  });

  it("templates: three drafts, one chosen, and it's in the reply box", () => {
    render(<TemplatesDemo playing={false} />);
    expect(screen.getByText("Welcome a new lead")).toBeInTheDocument();
    const drafts = screen.getAllByRole("listitem");
    expect(drafts).toHaveLength(3);
    expect(drafts.filter((d) => d.getAttribute("aria-current") === "true")).toHaveLength(1);
    expect(screen.getByTestId("reply-box")).toHaveTextContent(/Maya/);
  });

  // Client names are kept out of all code by the lint's own scan; here, the copy rule.
  it("no em dash in any demo", () => {
    const { container } = render(
      <>
        <CallsDemo playing={false} />
        <ChatsDemo playing={false} />
        <TemplatesDemo playing={false} />
      </>,
    );
    expect(container.textContent).not.toContain("—");
  });
});
