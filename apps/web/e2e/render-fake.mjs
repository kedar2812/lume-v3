// A stand-in for LUME's render service (apps/render) in e2e, on 127.0.0.1:3116: real thumbnails of photos (sharp),
// a page's picture with a PDF's first line for PDFs, a frame for videos, and a real two-page PDF for Office files.
// The real service is tested against the real tools in its own image (apps/render/test).
import http from "node:http";
import sharp from "sharp";

const PORT = Number(process.env.E2E_RENDER_PORT ?? 3116);
const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** A real PDF with one page per line, its cross-reference table counted, so pdf.js reads it. */
function pdfOf(lines) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objects.push(
    `<< /Type /Pages /Kids [${lines.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${lines.length} >>`,
  );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  lines.forEach((text, i) => {
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
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

/** The first line a PDF draws, and how many pages it has, read from the plain streams e2e's PDFs are made of. */
function readPdf(bytes) {
  const text = bytes.toString("latin1");
  const first = text.match(/\(([^)]{1,80})\)\s*Tj/)?.[1] ?? "Document";
  const pages = (text.match(/\/Type\s*\/Page(?!s)/g) ?? []).length || 1;
  const box = text.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
  return { first, pages, w: box ? Number(box[1]) : 612, h: box ? Number(box[2]) : 792 };
}

async function thumb(bytes, type) {
  if (type === "image/jpeg" || type === "image/png") {
    const img = sharp(bytes).rotate();
    const meta = await img.metadata();
    const webp = await img
      .resize(960, 960, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    return { webp, headers: { "x-width": String(meta.width), "x-height": String(meta.height) } };
  }
  if (type === "application/pdf") {
    const { first, pages, w, h } = readPdf(bytes);
    const scale = 960 / Math.max(w, h);
    const W = Math.round(w * scale);
    const H = Math.round(h * scale);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <rect x="${W * 0.08}" y="${H * 0.08}" width="${W * 0.84}" height="${H * 0.32}" rx="6" fill="#c9b8a3"/>
      <text x="${W * 0.08}" y="${H * 0.52}" font-family="DejaVu Sans, sans-serif" font-size="${H * 0.055}" font-weight="700" fill="#0a0c11">${esc(first)}</text>
      ${[0.6, 0.66, 0.72, 0.78].map((y, i) => `<rect x="${W * 0.08}" y="${H * y}" width="${W * (0.84 - i * 0.12)}" height="${H * 0.018}" rx="3" fill="#e3e6eb"/>`).join("")}
    </svg>`;
    const webp = await sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
    return {
      webp,
      headers: {
        "x-pages": String(pages),
        "x-width": String(Math.round(w)),
        "x-height": String(Math.round(h)),
      },
    };
  }
  if (type.startsWith("video/")) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
      <rect width="960" height="540" fill="#3a3330"/><rect x="100" y="120" width="300" height="240" rx="6" fill="#55493f"/>
      <rect x="520" y="250" width="340" height="110" rx="20" fill="#6d5f53"/><rect y="400" width="960" height="140" fill="#2b2522"/>
    </svg>`;
    const webp = await sharp(Buffer.from(svg)).webp({ quality: 82 }).toBuffer();
    return { webp, headers: { "x-duration-ms": "42000", "x-width": "1920", "x-height": "1080" } };
  }
  return null;
}

http
  .createServer((req, res) => {
    const parts = [];
    req.on("data", (b) => parts.push(b));
    req.on("end", async () => {
      try {
        const type = String(req.headers["content-type"] ?? "").split(";")[0];
        const body = Buffer.concat(parts);
        if (req.method === "GET" && req.url === "/healthz") return res.end('{"ok":true}');
        if (req.url === "/v1/pdf") {
          res.writeHead(200, { "content-type": "application/pdf" });
          return res.end(pdfOf(["How we work", "Our prices"]));
        }
        if (req.url === "/v1/thumb") {
          const t = await thumb(body, type);
          if (!t) return res.writeHead(415).end("{}");
          res.writeHead(200, { "content-type": "image/webp", ...t.headers });
          return res.end(t.webp);
        }
        res.writeHead(404).end();
      } catch (e) {
        res.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`render fake on ${PORT}`));
