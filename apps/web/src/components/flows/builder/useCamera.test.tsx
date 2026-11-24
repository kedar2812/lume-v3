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

describe("fitting the flow in view", () => {
  it("leaves the room asked for on the left (LUME AI's plan card), so no step lands under it", () => {
    let cam!: ReturnType<typeof useCamera>;
    function Fit() {
      cam = useCamera({ reduce: true });
      return <div ref={cam.hostRef} data-testid="fit" />;
    }
    render(
      <ReactFlowProvider>
        <Fit />
      </ReactFlowProvider>,
    );
    vi.spyOn(screen.getByTestId("fit"), "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 800,
      left: 0,
      top: 0,
    } as DOMRect);
    const box = { x: -300, y: 0, w: 1500, h: 600 };
    cam.fit(box, false, { left: 384 });
    expect(box.x * cam.cam.z + cam.cam.x).toBeGreaterThanOrEqual(384);
    cam.fit(box, false);
    expect(box.x * cam.cam.z + cam.cam.x).toBeLessThan(384);
  });
});
