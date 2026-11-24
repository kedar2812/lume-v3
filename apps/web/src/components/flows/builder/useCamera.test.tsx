import { ReactFlowProvider } from "@xyflow/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "./useCamera";

/** The camera's frames (review 2026-11-24): they stop once nothing moves, after a pinch too. */
function Host() {
  const cam = useCamera({ reduce: false });
  return <div ref={cam.hostRef} data-testid="host" />;
}

afterEach(() => vi.unstubAllGlobals());

describe("the camera's frames", () => {
  it("a pinch within the limits: the frames stop on their own soon after", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    render(
      <ReactFlowProvider>
        <Host />
      </ReactFlowProvider>,
    );
    fireEvent.wheel(screen.getByTestId("host"), { deltaY: 8, ctrlKey: true });
    expect(frames.length).toBeGreaterThan(0);
    let t = performance.now();
    let n = 0;
    while (frames.length && n < 300) {
      t += 16;
      frames.shift()!(t);
      n++;
    }
    // Done within the pinch's short wait (140 ms) and a frame: never a loop for as long as the builder is open.
    expect(frames.length).toBe(0);
    expect(n).toBeLessThan(30);
  });
});
