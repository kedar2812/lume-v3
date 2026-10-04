import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { lookOf } from "@/lib/avatar/look";
import { Avatar } from "./Avatar";

describe("Avatar (7C)", () => {
  it("shows the photo over the initials, and the initials alone if the photo can't load", () => {
    const { container } = render(<Avatar name="Riya Sharma" photo="/api/v1/users/u1/avatar?v=2" />);
    expect(screen.getByRole("img", { name: "Riya Sharma" })).toHaveTextContent("RS");
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: "Riya Sharma" })).toHaveTextContent("RS");
  });

  it("a look gives the chosen colour and a photo address that changes with each new photo", () => {
    expect(lookOf("u1", null)).toEqual({});
    expect(lookOf("u1", { color: "teal", version: 0, photo: false })).toEqual({ color: "#0B7285" });
    expect(lookOf("u1", { color: null, version: 7, photo: true })).toEqual({
      photo: "/api/v1/users/u1/avatar?v=7",
    });
  });
});
