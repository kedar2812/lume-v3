import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for LUME's render service (apps/render) over real HTTP: a WebP for every thumbnail, with what the real one
 * says of a PDF (its pages) and a video (its length), and a real PDF of two pages for every Office file. Tests make it
 * fail, go down or slow down through its fields.
 */
export type RenderFake = {
  url: string;
  calls: { path: string; type: string; size: number }[];
  /** The next N jobs answer 422, as a file the tools couldn't render. */
  fail: number;
  /** Every connection cut at once, as a service that isn't there. */
  down: boolean;
  /** How long each job takes. */
  slowMs: number;
  /** What a thumbnail answers instead of a WebP (a service gone wrong). */
  thumbBody: Buffer | null;
  close(): Promise<void>;
};

/** A real 1×1 WebP (lossless). */
export const FAKE_WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

/** A real PDF with one page per line of text, its cross-reference table counted, so pdf.js and poppler both read it. */
export function tinyPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
export const FAKE_PDF = tinyPdf(["Brightpath Interiors", "Our prices"]);

export async function startRenderFake(o: { port?: number } = {}): Promise<RenderFake> {
  const fake: RenderFake = {
    url: "",
    calls: [],
    fail: 0,
    down: false,
    slowMs: 0,
    thumbBody: null,
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = http.createServer((req, res) => {
    if (fake.down) return req.socket.destroy();
    const parts: Buffer[] = [];
    req.on("data", (b: Buffer) => parts.push(b));
    req.on("end", async () => {
      const path = req.url ?? "";
      const type = String(req.headers["content-type"] ?? "");
      if (req.method === "GET" && path === "/healthz") return res.end('{"ok":true}');
      fake.calls.push({ path, type, size: Buffer.concat(parts).length });
      if (fake.slowMs) await new Promise((r) => setTimeout(r, fake.slowMs));
      if (fake.fail > 0) {
        fake.fail--;
        res.writeHead(422, { "content-type": "application/json" });
        return res.end('{"error":"pdftoppm failed"}');
      }
      if (path === "/v1/pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        return res.end(FAKE_PDF);
      }
      if (path === "/v1/thumb") {
        const known: Record<string, string> =
          type === "application/pdf"
            ? { "x-pages": "2", "x-width": "612", "x-height": "792" }
            : type.startsWith("video/")
              ? { "x-duration-ms": "3000", "x-width": "640", "x-height": "360" }
              : { "x-width": "2000", "x-height": "1000" };
        res.writeHead(200, { "content-type": "image/webp", ...known });
        return res.end(fake.thumbBody ?? FAKE_WEBP);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
