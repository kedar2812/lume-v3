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

describe("a press while the camera moves", () => {
  /** The builder opening: the camera glides to fit the flow; a step is pressed while it's still on its way. */
  function glideThenPress(on: "node" | "canvas" | "tool" | "map") {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    let cam!: ReturnType<typeof useCamera>;
    function Glide() {
      cam = useCamera({ reduce: false });
      return (
        <div ref={cam.hostRef} data-testid="glide">
          <div className="react-flow__node" data-testid="step" />
          <div data-tool="">
            <button type="button" data-testid="tool" />
          </div>
          <div className="react-flow__minimap" data-testid="map" />
        </div>
      );
    }
    render(
      <ReactFlowProvider>
        <Glide />
      </ReactFlowProvider>,
    );
    vi.spyOn(screen.getByTestId("glide"), "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 800,
      left: 0,
      top: 0,
    } as DOMRect);
    let t = performance.now();
    const step = (n: number) => {
      for (let i = 0; i < n && frames.length; i++) frames.shift()!((t += 16));
    };
    // Where the fit goes (settled once), then away from it, then the fit again: pressed 3 frames into the glide.
    const box = { x: 2000, y: 1500, w: 600, h: 400 };
    cam.fit(box, false);
    step(400);
    const fitted = { ...cam.cam };
    cam.nudge(900, 700);
    step(400);
    cam.fit(box, false);
    step(3);
    const at = { ...cam.cam };
    fireEvent.pointerDown(
      screen.getByTestId({ node: "step", canvas: "glide", tool: "tool", map: "map" }[on]),
      {
        button: 0,
        pointerId: 1,
        clientX: 600,
        clientY: 400,
      },
    );
    step(400);
    return { at, now: cam.cam, goal: fitted };
  }

  it("on a step: the camera stops where it is, so the step stays under the pointer and the press is its", () => {
    const { at, now } = glideThenPress("node");
    expect(at.x).not.toBe(0);
    expect(now).toEqual(at);
  });

  it("on the canvas itself: the camera stops there too", () => {
    const { at, now } = glideThenPress("canvas");
    expect(now).toEqual(at);
  });

  // Review 2026-11-27: + and − pressed fast add up (each from where the last was going), and LUME AI's bar or plan
  // card pressed while it fits the next flow in view must not leave its steps off screen.
  it("on a tool (the zoom bar, a panel, LUME AI's bar): the camera carries on to where it was going", () => {
    const { at, now, goal } = glideThenPress("tool");
    expect(now).not.toEqual(at);
    expect(now).toEqual(goal);
  });

  it("on the map: the camera carries on too (its click moves it anyway)", () => {
    const { now, goal } = glideThenPress("map");
    expect(now).toEqual(goal);
  });
});

describe("a press that moves", () => {
  function pressAndMove(on: "node" | "canvas") {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    let cam!: ReturnType<typeof useCamera>;
    function Drag() {
      cam = useCamera({ reduce: true });
      return (
        <div ref={cam.hostRef} data-testid="drag">
          <div className="react-flow__node" data-testid="card" />
        </div>
      );
    }
    render(
      <ReactFlowProvider>
        <Drag />
      </ReactFlowProvider>,
    );
    const host = screen.getByTestId("drag");
    host.setPointerCapture = () => undefined;
    const at = { ...cam.cam };
    fireEvent.pointerDown(screen.getByTestId(on === "node" ? "card" : "drag"), {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(host, { pointerId: 1, buttons: 1, clientX: 260, clientY: 180 });
    let t = performance.now();
    for (let i = 0; i < 5 && frames.length; i++) frames.shift()!((t += 16));
    return { at, now: cam.cam };
  }

  it("on a step: never a pan (the step is React Flow's to drag)", () => {
    const { at, now } = pressAndMove("node");
    expect(now).toEqual(at);
  });

  it("on the canvas itself: the canvas pans with the pointer", () => {
    const { at, now } = pressAndMove("canvas");
    expect(now.x - at.x).toBe(160);
    expect(now.y - at.y).toBe(80);
  });
});
