import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SendFrom } from "./SendFrom";

const business = { id: "n1", display: "+91 90000 00001", whose: "the business's" };
const own = { id: "n2", display: "+91 90000 00002", whose: "Riya Sharma's" };

describe("Send from", () => {
  it("no number: nothing to say", () => {
    const { container } = render(<SendFrom numbers={[]} value={null} onChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("one number: named, with no choice to make", () => {
    render(<SendFrom numbers={[business]} value={null} onChange={() => undefined} />);
    expect(screen.getByText("Sends from +91 90000 00001 · the business's")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("two or more: nothing chosen for them, each says whose it is, and a choice is told", async () => {
    const onChange = vi.fn();
    render(<SendFrom numbers={[business, own]} value={null} onChange={onChange} />);
    const group = screen.getByRole("radiogroup", { name: "Send from" });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("Choose the number this run sends from")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /\+91 90000 00002.*Riya Sharma's/ }));
    expect(onChange).toHaveBeenCalledWith("n2");
  });

  it("chosen: that one is checked and the ask goes", () => {
    render(<SendFrom numbers={[business, own]} value="n1" onChange={() => undefined} />);
    expect((screen.getByRole("radio", { name: /\+91 90000 00001/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Choose the number this run sends from")).toBeNull();
  });

  it("one that can't be used: says why and can't be chosen", () => {
    render(
      <SendFrom
        numbers={[business, { ...own, problem: "WhatsApp rated +91 90000 00002 red." }]}
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole("radio", { name: /\+91 90000 00002/ })).toBeDisabled();
    expect(screen.getByText("WhatsApp rated +91 90000 00002 red.")).toBeInTheDocument();
  });

  it("the only number, unusable: named with why", () => {
    render(
      <SendFrom
        numbers={[{ ...business, problem: "Not approved yet." }]}
        value={null}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText("Sends from +91 90000 00001 · the business's")).toBeInTheDocument();
    expect(screen.getByText("Not approved yet.")).toBeInTheDocument();
  });
});
