import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LeadWatermark } from "./LeadWatermark";

let path = "/leads";
vi.mock("next/navigation", () => ({ usePathname: () => path }));
const viewer = { name: "Sam Okafor", email: "sam@example.test", today: "2026-10-01" };

describe("the watermark on lead screens (6A)", () => {
  it("covers the leads list, a lead and the board for a watched person", () => {
    for (const p of ["/leads", "/pipeline"]) {
      path = p;
      const { container, unmount } = render(<LeadWatermark show viewer={viewer} />);
      expect(container.querySelector("[data-watermark]")).toHaveAttribute(
        "data-watermark",
        "Sam Okafor · sam@example.test · Oct 1",
      );
      unmount();
    }
  });

  it("is nowhere else, and never for someone it doesn't apply to", () => {
    path = "/settings/account";
    expect(render(<LeadWatermark show viewer={viewer} />).container).toBeEmptyDOMElement();
    path = "/leads";
    expect(render(<LeadWatermark show={false} viewer={viewer} />).container).toBeEmptyDOMElement();
  });

  it("takes no clicks and hides from screen readers", () => {
    path = "/leads";
    const { container } = render(<LeadWatermark show viewer={viewer} />);
    expect(container.querySelector("[data-watermark]")).toHaveAttribute("aria-hidden", "true");
  });
});
