import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, type Limits } from "./limits";
import { RenderError } from "./run";
import { renderServer, type Engine } from "./server";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const DOCX = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(40)]);

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(engine: Partial<Engine>, limits: Partial<Limits> = {}) {
  const full: Engine = {
    thumb: async () => ({ webp: WEBP }),
    pdf: async () => Buffer.from("%PDF-1.7\n"),
    photo: async () => JPEG,
    ...engine,
  };
  server = renderServer(full, { ...LIMITS, ...limits }, () => {});
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return (path: string, body: Buffer, type: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body, headers: { "content-type": type } });
}

describe("LUME's render service", () => {
  it("a thumbnail comes back as WebP, with what's known about the file", async () => {
    const post = await start({
      thumb: async () => ({ webp: WEBP, pages: 3, width: 612, height: 792 }),
    });
    const r = await post("/v1/thumb", PNG, "image/png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(r.headers.get("x-pages")).toBe("3");
    expect(r.headers.get("x-width")).toBe("612");
    expect(r.headers.get("x-height")).toBe("792");
    expect(r.headers.get("x-duration-ms")).toBeNull();
    expect(Buffer.from(await r.arrayBuffer())).toEqual(WEBP);
  });

  it("a photo comes back as a JPEG that fits WhatsApp; only photos are taken", async () => {
    let asked: string | null = null;
    const post = await start({ photo: async (_b, mime) => ((asked = mime), JPEG) });
    const r = await post("/v1/photo", PNG, "image/png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(JPEG);
    expect(asked).toBe("image/png");
    expect((await post("/v1/photo", Buffer.from("%PDF-1.7\n"), "application/pdf")).status).toBe(415);
  });

  it("an Office file comes back as a PDF", async () => {
    const post = await start({});
    const r = await post(
      "/v1/pdf",
      DOCX,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
  });

  it("a body over 26 MB is 413, and never reaches a tool", async () => {
    let called = false;
    const post = await start({ thumb: async () => ((called = true), { webp: WEBP }) });
    const big = Buffer.concat([PNG, Buffer.alloc(27 * 1024 * 1024)]);
    const r = await post("/v1/thumb", big, "image/png");
    expect(r.status).toBe(413);
    expect(called).toBe(false);
  });

  it("a kind it doesn't take is 415: HTML for a thumbnail, a photo for a PDF", async () => {
    const post = await start({});
    expect((await post("/v1/thumb", Buffer.from("<html></html>"), "text/html")).status).toBe(415);
    expect((await post("/v1/pdf", PNG, "image/png")).status).toBe(415);
  });

  it("bytes that aren't what they're called are 415: an HTML page called a PNG", async () => {
    const post = await start({});
    const r = await post("/v1/thumb", Buffer.from("<svg onload=alert(1)>"), "image/png");
    expect(r.status).toBe(415);
  });

  it("a file the tools couldn't render is 422", async () => {
    const post = await start({
      thumb: async () => {
        throw new RenderError("pdftoppm took longer than 45 s");
      },
    });
    const r = await post("/v1/thumb", Buffer.from("%PDF-1.7\n"), "application/pdf");
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "pdftoppm took longer than 45 s" });
  });

  it("one job at a time: two at once both answer, one after the other", async () => {
    let running = 0;
    let most = 0;
    const post = await start({
      thumb: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 100));
        running--;
        return { webp: WEBP };
      },
    });
    const [a, b] = await Promise.all([
      post("/v1/thumb", PNG, "image/png"),
      post("/v1/thumb", PNG, "image/png"),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(most).toBe(1);
  });

  it("a queue that's full is 503, so LUME tries again later", async () => {
    let release = () => {};
    const post = await start(
      { thumb: () => new Promise((r) => (release = () => r({ webp: WEBP }))) },
      { queue: 1 },
    );
    const first = post("/v1/thumb", PNG, "image/png");
    await new Promise((r) => setTimeout(r, 50));
    const second = await post("/v1/thumb", PNG, "image/png");
    expect(second.status).toBe(503);
    release();
    expect((await first).status).toBe(200);
  });

  it("anything else is 404; health is 200", async () => {
    const post = await start({});
    expect((await post("/v1/run", PNG, "image/png")).status).toBe(404);
    const { port } = server!.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });
});
