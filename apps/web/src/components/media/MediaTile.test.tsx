import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LibraryFile } from "@/lib/files/client";
import { lengthText, mediaMeta, mediaWord } from "@/lib/files/words";
import { MediaTile } from "./MediaTile";

const base: LibraryFile = {
  id: "f1",
  name: "Proposal.docx",
  kind: "document",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 88_064,
  link: { on: false, url: null, opens: 0 },
  createdAt: "2026-10-19T06:00:00.000Z",
  archived: false,
  viewAs: "office",
  preview: "none",
  thumbUrl: null,
  pages: null,
  durationMs: null,
  width: null,
  height: null,
};

describe("what a file is, in words", () => {
  it.each([
    [{ viewAs: "image", mime: "image/png" }, "Photo"],
    [{ viewAs: "video", mime: "video/mp4" }, "Video"],
    [{ viewAs: "audio", mime: "audio/ogg" }, "Audio"],
    [{ viewAs: "pdf", mime: "application/pdf" }, "PDF"],
    [{ viewAs: "office", mime: "application/msword" }, "Word"],
    [{ viewAs: "office", mime: "application/vnd.ms-powerpoint" }, "PowerPoint"],
    [
      { viewAs: "office", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
      "PowerPoint",
    ],
    [{ viewAs: "sheet", mime: "application/vnd.ms-excel" }, "Excel"],
    [{ viewAs: "text", mime: "text/plain" }, "Text"],
  ] as const)("%o is a %s", (f, word) => {
    expect(mediaWord({ ...base, ...f })).toBe(word);
  });

  it("lengths read as a clock", () => {
    expect(lengthText(5_000)).toBe("0:05");
    expect(lengthText(65_000)).toBe("1:05");
    expect(lengthText(3_725_000)).toBe("1:02:05");
  });

  it("a tile's line: the kind, then pages or length when known, then the size", () => {
    expect(mediaMeta({ ...base, viewAs: "pdf", mime: "application/pdf", pages: 1, size: 419_840 })).toBe(
      "PDF · 1 page · 410 KB",
    );
    expect(
      mediaMeta({ ...base, viewAs: "video", mime: "video/mp4", durationMs: 42_000, size: 9_856_614 }),
    ).toBe("Video · 0:42 · 9.4 MB");
    expect(
      mediaMeta({
        ...base,
        mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pages: 12,
      }),
    ).toBe("PowerPoint · 12 slides · 86 KB");
    expect(mediaMeta(base)).toBe("Word · 86 KB");
  });
});

describe("a tile", () => {
  it("with no preview shows what the file is, never a broken picture", () => {
    render(<MediaTile file={base} onOpen={vi.fn()} />);
    const t = screen.getByRole("button", { name: /^Proposal\.docx/ });
    expect(t.querySelector("img")).toBeNull();
    expect(t).toHaveTextContent("DOCX");
    expect(t).not.toHaveTextContent("Preview on its way");
  });

  it("a thumbnail the browser already had (loaded before the page came alive) still shows", () => {
    const complete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const natural = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth");
    Object.defineProperty(HTMLImageElement.prototype, "complete", { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get: () => 960 });
    try {
      render(<MediaTile file={{ ...base, preview: "ready", thumbUrl: "/t1" }} onOpen={vi.fn()} />);
      expect(screen.getByRole("button", { name: /^Proposal\.docx/ }).querySelector("img")).toHaveAttribute(
        "data-loaded",
      );
    } finally {
      if (complete) Object.defineProperty(HTMLImageElement.prototype, "complete", complete);
      if (natural) Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", natural);
    }
  });

  it("a video says its length on its picture, and opens on a tap", async () => {
    const onOpen = vi.fn();
    const clip = {
      ...base,
      id: "v1",
      name: "Visit.mp4",
      kind: "video" as const,
      mime: "video/mp4",
      viewAs: "video" as const,
      preview: "ready" as const,
      thumbUrl: "/t",
      durationMs: 65_000,
    };
    render(<MediaTile file={clip} onOpen={onOpen} />);
    const t = screen.getByRole("button", { name: /^Visit\.mp4/ });
    expect(t).toHaveAccessibleName("Visit.mp4, Video · 1:05 · 86 KB");
    await userEvent.click(t);
    expect(onOpen).toHaveBeenCalledWith("v1");
  });
});
