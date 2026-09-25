import { describe, expect, it } from "vitest";
import { LEGAL_DOCUMENTS, LEGAL_VERSION, needsAgreement } from "./documents";

describe("legal documents", () => {
  it("has the licence agreement, the terms and the privacy policy, each with real content", () => {
    expect(LEGAL_DOCUMENTS.map((d) => d.id)).toEqual(["licence", "terms", "privacy"]);
    for (const doc of LEGAL_DOCUMENTS) {
      expect(doc.title).toMatch(/\S/);
      expect(doc.sections.length).toBeGreaterThanOrEqual(5);
      for (const s of doc.sections) {
        expect(s.heading).toMatch(/\S/);
        expect(s.paragraphs.length).toBeGreaterThan(0);
      }
    }
  });

  it("dates its version, and asks again whenever the version changes", () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(needsAgreement(null)).toBe(true);
    expect(needsAgreement("2020-01-01")).toBe(true);
    expect(needsAgreement(LEGAL_VERSION)).toBe(false);
  });

  it("tells people that a changed version will be put in front of them again", () => {
    const text = JSON.stringify(LEGAL_DOCUMENTS);
    expect(text).toMatch(/asked to agree again/i);
  });
});
