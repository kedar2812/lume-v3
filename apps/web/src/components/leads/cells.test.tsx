import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { WhenCell } from "./cells";

afterEach(() => void vi.useRealTimers());

it("a minute that ticks over between the server's drawing and the browser's is no mistake", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-11-25T10:59:59Z");
  const cell = <WhenCell iso="2026-11-25T10:00:00Z" />;
  const host = document.createElement("div");
  host.innerHTML = renderToString(cell);
  expect(host).toHaveTextContent("59m ago");
  vi.setSystemTime("2026-11-25T11:00:01Z");
  const wrong = vi.fn();
  const root = await act(async () => hydrateRoot(host, cell, { onRecoverableError: wrong }));
  expect(wrong).not.toHaveBeenCalled();
  // The next time it's drawn it is true.
  await act(async () => root.render(<WhenCell iso="2026-11-25T10:00:00Z" key="again" />));
  expect(host).toHaveTextContent("1h ago");
});
