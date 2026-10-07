import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretBox } from "./SecretStep";

afterEach(() => vi.unstubAllGlobals());

describe("copying a webhook's secret (shown once)", () => {
  it("says Copied only when it really was", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<SecretBox secret="whsec_abc" />);
    await userEvent.click(screen.getByRole("button", { name: /Copy secret/i }));
    expect(writeText).toHaveBeenCalledWith("whsec_abc");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
  it("no clipboard, or a refused one: never claims it was copied", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const a = render(<SecretBox secret="whsec_abc" />);
    await userEvent.click(screen.getByRole("button", { name: /Copy secret/i }));
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    a.unmount();
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    render(<SecretBox secret="whsec_abc" />);
    await userEvent.click(screen.getByRole("button", { name: /Copy secret/i }));
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});
