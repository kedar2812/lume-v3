import { describe, expect, it } from "vitest";
import { LIMITS, sniffType } from "./sniff";

/** What a file really is, from its first bytes, never its name or the browser's word for it (plan W3a outcome 12). */
const b = (...parts: (number[] | string)[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
const ftyp = (brand: string) => b([0, 0, 0, 0x18], "ftyp", brand, "\0\0\0\0isommp42");
const zip = (inside: string) =>
  b("PK\x03\x04", "\0".repeat(26), "[Content_Types].xml", "\0".repeat(10), inside);

describe("sniffType", () => {
  it("photos, videos, voice notes and documents WhatsApp takes, by their bytes", () => {
    const cases: [Buffer, string | undefined, { mime: string; kind: string }][] = [
      [b([0xff, 0xd8, 0xff, 0xe0], "JFIF"), "x.bin", { mime: "image/jpeg", kind: "image" }],
      [b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), undefined, { mime: "image/png", kind: "image" }],
      [ftyp("isom"), "clip", { mime: "video/mp4", kind: "video" }],
      [ftyp("3gp5"), undefined, { mime: "video/3gpp", kind: "video" }],
      [ftyp("M4A "), undefined, { mime: "audio/mp4", kind: "audio" }],
      [b("OggS", "\0\x02"), undefined, { mime: "audio/ogg", kind: "audio" }],
      [b("ID3", [3, 0]), undefined, { mime: "audio/mpeg", kind: "audio" }],
      [b([0xff, 0xfb, 0x90]), undefined, { mime: "audio/mpeg", kind: "audio" }],
      [b([0xff, 0xf1, 0x50]), undefined, { mime: "audio/aac", kind: "audio" }],
      [b("#!AMR\n"), undefined, { mime: "audio/amr", kind: "audio" }],
      [b("%PDF-1.7\n"), "Prices.pdf", { mime: "application/pdf", kind: "document" }],
      [
        zip("word/document.xml"),
        "Quote.docx",
        { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
      ],
      [
        zip("xl/workbook.xml"),
        "Prices.xlsx",
        { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "document" },
      ],
      [
        zip("ppt/presentation.xml"),
        "Deck.pptx",
        {
          mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          kind: "document",
        },
      ],
      [
        b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        "Old.doc",
        { mime: "application/msword", kind: "document" },
      ],
      [
        b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        "Old.XLS",
        { mime: "application/vnd.ms-excel", kind: "document" },
      ],
      [b("Opening hours: 10 to 7\nनमस्ते\n"), "notes.txt", { mime: "text/plain", kind: "document" }],
    ];
    for (const [bytes, name, want] of cases) expect([name, sniffType(bytes, name)]).toEqual([name, want]);
  });

  it("anything else is refused, whatever it's called: HTML, SVG, scripts, programs, a plain zip, empty", () => {
    for (const [bytes, name] of [
      [b("<!doctype html><script>alert(1)</script>"), "photo.jpg"],
      [b("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), "logo.png"],
      [b("MZ\x90\0"), "brochure.pdf"],
      [b([0x7f], "ELF"), "a.pdf"],
      [b("PK\x03\x04", "\0".repeat(30), "anything.txt"), "files.zip"],
      [b([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "macro.msi"],
      [b("text with a\0NUL"), "notes.txt"],
      [b([0xc3, 0x28]), "bad-utf8.txt"],
      [b("plain words"), "notes.html"],
      [Buffer.alloc(0), "empty.pdf"],
    ] as const)
      expect([name, sniffType(bytes, name)]).toEqual([name, null]);
  });

  it("each kind has WhatsApp's limit", () => {
    expect(LIMITS).toEqual({
      image: 5 * 1024 * 1024,
      video: 16 * 1024 * 1024,
      audio: 16 * 1024 * 1024,
      document: 25 * 1024 * 1024,
    });
  });
});
