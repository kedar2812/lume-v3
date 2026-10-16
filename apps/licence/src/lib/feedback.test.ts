import { describe, expect, it } from "vitest";
import { browserName, bugReport, isBehind, statusText } from "./feedback";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("browserName", () => {
  it("names the browser and the system in words", () => {
    expect(browserName(CHROME_WIN)).toBe("Chrome 141 on Windows");
    expect(
      browserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      ),
    ).toBe("Safari 18 on macOS");
    expect(browserName(`${CHROME_WIN} Edg/141.0.0.0`)).toBe("Edge 141 on Windows");
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe(
      "Firefox 131 on Linux",
    );
    expect(
      browserName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 18 on iPhone");
    expect(
      browserName(
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome 141 on Android");
    expect(browserName("curl/8.0")).toBe("curl/8.0");
  });
});

describe("statusText and isBehind", () => {
  it("says the status, with its release when fixed", () => {
    expect(statusText("fixed", "1.4.2")).toBe("Fixed in 1.4.2");
    expect(statusText("not_a_bug", null)).toBe("Not a bug");
    expect(statusText("seen", null)).toBe("Seen");
  });
  it("is behind only when the latest release is newer", () => {
    expect(isBehind("1.4.1", "1.4.2")).toBe(true);
    expect(isBehind("1.10.0", "1.9.9")).toBe(false);
    expect(isBehind("1.4.2", "1.4.2")).toBe(false);
    expect(isBehind("1.4.2", null)).toBe(false);
  });
});

describe("bugReport", () => {
  const d = {
    kind: "bug" as const,
    firstLine: "It jumped back.",
    text: "It jumped back.\n```\nconsole.log(1)\n```\n<img src=x onerror=alert(1)>",
    client: { name: "Harbour Clinic" },
    reporter: { role: "Sales rep" },
    page: "/pipeline",
    appVersion: "1.4.1",
    browser: CHROME_WIN,
    screen: "1536 × 864 · 1.25×",
    theme: "porcelain" as const,
    receivedAt: "2026-10-16T04:44:00.000Z",
    imageCount: 2,
  };
  it("is Markdown with the words fenced longer than any fence inside them, and no name or email", () => {
    const md = bugReport(d);
    expect(md.startsWith("## Something's broken: It jumped back.\n")).toBe(true);
    expect(md).toContain("````\nIt jumped back.\n```\nconsole.log(1)\n```\n<img src=x onerror=alert(1)>\n````");
    expect(md).toContain("- Client: Harbour Clinic");
    expect(md).toContain("- Reporter: Sales rep");
    expect(md).toContain("- Page: `/pipeline`");
    expect(md).toContain("- LUME: 1.4.1");
    expect(md).toContain("- Browser: Chrome 141 on Windows");
    expect(md).toContain("- Theme: Porcelain");
    expect(md).toContain("- 2 screenshots (download them from the dashboard)");
    expect(md).not.toContain("Priya");
    expect(md).not.toContain("@");
  });
  it("fences plain words with three backticks, and says nothing of screenshots when there were none", () => {
    const md = bugReport({ ...d, text: "Plain words", imageCount: 0 });
    expect(md).toContain("```\nPlain words\n```");
    expect(md).not.toContain("screenshot");
  });
});
