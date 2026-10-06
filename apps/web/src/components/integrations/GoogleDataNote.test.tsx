import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GoogleDataNote, LUME_PRIVACY_URL } from "./GoogleDataNote";

describe("the Google data notice (Google verification: in-product privacy notice)", () => {
  it("says what LUME reads, and links LUME's privacy policy and Google's User Data Policy", () => {
    render(<GoogleDataNote what="LUME reads events on calendars you own, read-only." />);
    expect(screen.getByText(/LUME reads events on calendars you own, read-only\./)).toHaveTextContent(
      /Limited Use requirements: it is never sold or used for ads/,
    );
    expect(screen.getByRole("link", { name: "privacy policy" })).toHaveAttribute("href", LUME_PRIVACY_URL);
    expect(screen.getByRole("link", { name: "Google API Services User Data Policy" })).toHaveAttribute(
      "href",
      "https://developers.google.com/terms/api-services-user-data-policy",
    );
  });
});
