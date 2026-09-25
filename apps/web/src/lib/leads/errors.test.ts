import { describe, expect, it } from "vitest";
import { fieldErrors } from "./errors";
import { testCatalog } from "./test-catalog";

const cat = testCatalog();

describe("fieldErrors", () => {
  it("turns the API's schema errors into plain words under the right field", () => {
    const r = {
      ok: false as const,
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request is invalid",
      details: [
        { instancePath: "/email", message: "Invalid email address" },
        { instancePath: "/name", message: "Too small" },
        { instancePath: "/value", message: "Too big" },
      ],
    };
    expect(fieldErrors(r, cat)).toEqual({
      email: "Enter a valid email address",
      name: "Give the lead a name",
      value: "Enter an amount from 0 up to 1 trillion",
    });
  });

  it("names the custom field in its message", () => {
    const r = {
      ok: false as const,
      status: 400,
      code: "INVALID_CUSTOM_FIELDS",
      message: "Some fields are invalid",
      details: [{ path: "struggles", message: "unknown option" }],
    };
    expect(fieldErrors(r, cat)).toEqual({ struggles: "That isn’t one of the Struggles options" });
  });

  it("returns nothing for errors that aren't about a field", () => {
    expect(fieldErrors({ ok: false, status: 409, code: "VERSION_CONFLICT", message: "x" }, cat)).toEqual({});
  });
});
