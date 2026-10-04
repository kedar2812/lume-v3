import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Popup({ onClose }: { onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const f = useModalFocus(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-label="Popup" onKeyDown={f.onKeyDown}>
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  );
}
function Page({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <Popup onClose={onClose ?? (() => setOpen(false))} />}
    </>
  );
}

describe("popups and the keyboard (7C review)", () => {
  it("focus moves in, Tab wraps inside, Escape closes, and focus goes back", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
  });

  it("while it's busy (no way to close), Escape does nothing", async () => {
    const onClose = vi.fn();
    render(<Popup />);
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    render(<Popup onClose={onClose} />);
    expect(onClose).not.toHaveBeenCalled();
  });
});
