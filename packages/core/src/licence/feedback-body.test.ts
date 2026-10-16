import { describe, expect, it } from "vitest";
import { feedbackBody } from "./token";

describe("feedbackBody", () => {
  it("is exactly the report, who sent it, and the install's credentials", () => {
    const b = feedbackBody({
      instanceId: "LUME-H4RB-8C2L",
      licenseKey: "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K",
      installId: "0190e0c0-0000-7000-8000-0000000000aa",
      appVersion: "1.5.0",
      browser: "Mozilla/5.0",
      reporter: { name: "Priya Shah", email: "priya@harbour.example", role: "Sales rep" },
      report: {
        kind: "bug",
        text: "It jumped back",
        page: "/pipeline",
        theme: "porcelain",
        screen: "1536 × 864 · 1.25×",
        images: [{ type: "image/webp", data: "UklGRg==" }],
      },
    });
    expect(Object.keys(b).sort()).toEqual(
      [
        "appVersion",
        "browser",
        "images",
        "installId",
        "instanceId",
        "kind",
        "licenseKey",
        "page",
        "reporter",
        "screen",
        "text",
        "theme",
      ].sort(),
    );
    expect(b.reporter).toEqual({ name: "Priya Shah", email: "priya@harbour.example", role: "Sales rep" });
    expect(b.images).toEqual([{ type: "image/webp", data: "UklGRg==" }]);
  });
});
