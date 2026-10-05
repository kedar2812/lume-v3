import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FieldDefView } from "@/lib/leads/types";
import { testCatalog, testLead } from "@/lib/leads/test-catalog";
import { CatalogProvider } from "../CatalogProvider";
import { FieldValue } from "./FieldValue";

const SRC = "0190e0c0-0000-7000-8000-00000000c5c5";
const source: FieldDefView = {
  id: "f-source",
  key: "source",
  label: "Source",
  type: "text",
  options: [],
  isCore: true,
  isRequired: false,
  archived: false,
  access: "view",
};
const show = (sourceId: string | null) =>
  render(
    <CatalogProvider catalog={testCatalog()}>
      <FieldValue lead={testLead({ sourceId })} def={source} />
    </CatalogProvider>,
  );

describe("a lead's source, as a person reads it", () => {
  it("names the source it came from", () => {
    show(SRC);
    expect(screen.getByText("leads-march.csv")).toBeInTheDocument();
  });
  it("one added by hand says so; a source since removed says that", () => {
    const { unmount } = show(null);
    expect(screen.getByText("Added in LUME")).toBeInTheDocument();
    unmount();
    show("0190e0c0-0000-7000-8000-000000000999");
    expect(screen.getByText("A source since removed")).toBeInTheDocument();
  });
});
