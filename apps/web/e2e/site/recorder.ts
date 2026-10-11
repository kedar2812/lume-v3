import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CDPSession, Locator, Page } from "@playwright/test";

/**
 * A scene of the product tour, recorded: the page's own frames (Chrome's screencast, at the device's pixels) and
 * a log of what the viewer should see on top — where the cursor goes and when, each click, where the camera
 * looks. Headless Chrome draws no cursor; the tour's renderer (scripts/tour/render.py) draws one from this log,
 * eases the camera and cuts the waits. Times are seconds since the epoch, the screencast's own clock.
 */
type Box = { x: number; y: number; w: number; h: number };
export type TourEvent =
  | { k: "move"; t0: number; t1: number; from: [number, number]; to: [number, number] }
  | { k: "click"; t: number; at: [number, number] }
  | { k: "zoom"; t: number; box: Box | null }
  | { k: "cut"; t0: number; t1: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export class Recorder {
  private cdp?: CDPSession;
  private frames: { file: string; t: number }[] = [];
  private events: TourEvent[] = [];
  private n = 0;
  private pos: [number, number];
  private pending: Promise<unknown>[] = [];

  constructor(
    readonly page: Page,
    private dir: string,
    private viewport: { width: number; height: number },
  ) {
    this.pos = [viewport.width * 0.62, viewport.height * 0.72];
  }

  async start() {
    mkdirSync(path.join(this.dir, "frames"), { recursive: true });
    await this.page.mouse.move(...this.pos);
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (f) => {
      const file = `frames/${String(this.n++).padStart(5, "0")}.jpg`;
      writeFileSync(path.join(this.dir, file), Buffer.from(f.data, "base64"));
      this.frames.push({ file, t: f.metadata.timestamp ?? now() });
      this.pending.push(
        this.cdp!.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined),
      );
    });
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 94,
      maxWidth: this.viewport.width * 3,
      maxHeight: this.viewport.height * 3,
      everyNthFrame: 1,
    });
    await sleep(300);
  }

  async stop(meta: Record<string, unknown> = {}) {
    await sleep(400);
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
    await Promise.all(this.pending);
    writeFileSync(
      path.join(this.dir, "tour.json"),
      JSON.stringify({ viewport: this.viewport, frames: this.frames, events: this.events, ...meta }, null, 1),
    );
  }

  /** Linger: the viewer reads. */
  hold(ms: number) {
    return sleep(ms);
  }

  async boxOf(target: Locator): Promise<Box> {
    await target.waitFor({ state: "visible" });
    // Aim only once the target and everything holding it have stopped moving (a bar sliding up, a drawer
    // sliding in): a box measured mid-flight sends the click somewhere else.
    await target
      .evaluate((el) => {
        const moving: Animation[] = [];
        for (let a: Element | null = el; a; a = a.parentElement)
          moving.push(...a.getAnimations().filter((x) => x.effect?.getTiming().iterations !== Infinity));
        return Promise.race([
          Promise.all(moving.map((x) => x.finished.catch(() => undefined))),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      })
      .catch(() => undefined);
    const b = await target.boundingBox();
    if (!b) throw new Error(`no box for ${target}`);
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }

  /** The cursor glides to the target's middle (or a point in it, as fractions), hovering on the way. */
  async moveTo(target: Locator | [number, number], at: [number, number] = [0.5, 0.5], ms = 650) {
    let to: [number, number];
    if (Array.isArray(target)) to = target;
    else {
      const b = await this.boxOf(target);
      to = [b.x + b.w * at[0], b.y + b.h * at[1]];
    }
    const from = this.pos;
    const t0 = now();
    // A few real steps are enough for hover states: the renderer draws the glide itself, and every real step
    // costs a repaint at 2× on the build box.
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const e = ease(i / steps);
      await this.page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e);
      await sleep(ms / steps);
    }
    this.events.push({ k: "move", t0, t1: now(), from, to });
    this.pos = to;
  }

  async click(
    target: Locator,
    opts: { at?: [number, number]; ms?: number; modifiers?: ("Control" | "Shift")[] } = {},
  ) {
    await this.moveTo(target, opts.at, opts.ms);
    await sleep(110);
    this.events.push({ k: "click", t: now(), at: this.pos });
    for (const m of opts.modifiers ?? []) await this.page.keyboard.down(m);
    await this.page.mouse.down();
    await sleep(70);
    await this.page.mouse.up();
    for (const m of opts.modifiers ?? []) await this.page.keyboard.up(m);
    await sleep(160);
  }

  async type(text: string, delay = 55) {
    await this.page.keyboard.type(text, { delay });
  }

  /** The camera eases in on a box (an element, or several together), or back out to the whole screen. */
  async zoom(target: Locator | Locator[] | Box | null) {
    let box: Box | null = null;
    if (target && "x" in target && typeof target.x === "number") box = target as Box;
    else if (target) {
      const boxes = await Promise.all(
        (Array.isArray(target) ? target : [target as Locator]).map((t) => this.boxOf(t)),
      );
      const x = Math.min(...boxes.map((b) => b.x));
      const y = Math.min(...boxes.map((b) => b.y));
      box = {
        x,
        y,
        w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
        h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
      };
    }
    this.events.push({ k: "zoom", t: now(), box });
  }

  /** Something the viewer needn't wait for (a page loading): the renderer cuts it out. */
  async cut<T>(work: () => Promise<T>): Promise<T> {
    const t0 = now();
    const r = await work();
    await sleep(250);
    this.events.push({ k: "cut", t0, t1: now() });
    return r;
  }

  /** A smooth scroll by the wheel, over the cursor. */
  async scroll(dy: number, ms = 700) {
    const steps = Math.max(6, Math.round(ms / 25));
    let done = 0;
    for (let i = 1; i <= steps; i++) {
      const want = Math.round(dy * ease(i / steps));
      await this.page.mouse.wheel(0, want - done);
      done = want;
      await sleep(ms / steps);
    }
  }
}
