import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Upload } from "@/lib/media/uploads";
import { UploadTray } from "./UploadTray";

/** The tray (canvas Drop): each file's own progress, and the whole batch's on one bar (owner, 2026-10-25). */
const up = (name: string, o: Partial<Upload> = {}): Upload => ({
  key: name,
  name,
  size: 1000,
  share: 0,
  state: "waiting",
  problem: null,
  ...o,
});

describe("UploadTray", () => {
  it("one bar for the whole batch, with how many are in", () => {
    render(
      <UploadTray
        uploads={[up("a.jpg", { state: "uploading", share: 0.5 }), up("b.jpg")]}
        batch={{ total: 3, added: 1, share: 0.55, done: false }}
        onDismiss={() => {}}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Adding files" });
    expect(bar).toHaveAttribute("aria-valuenow", "55");
    expect(screen.getByText("1 of 3 added · 55%")).toBeInTheDocument();
    expect(screen.getByText("Adding 2 files")).toBeInTheDocument();
  });

  it("done: the bar full and the batch said", () => {
    render(
      <UploadTray
        uploads={[up("a.jpg", { state: "added", share: 1 })]}
        batch={{ total: 3, added: 3, share: 1, done: true }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Adding files" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByText("3 files added")).toBeInTheDocument();
  });

  it("no bar when every file was refused", () => {
    render(
      <UploadTray
        uploads={[up("a.exe", { state: "refused", problem: "LUME can send photos…" })]}
        batch={null}
        onDismiss={() => {}}
      />,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("LUME can send photos…");
  });
});
