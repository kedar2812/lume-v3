import { describe, expect, it } from "vitest";
import { clientMessage, whatsappLink } from "./message";

describe("the message for a client (spec 2026-10-15 §3.1)", () => {
  it("names their address and the key, and says it's for one server", () => {
    expect(clientMessage("harbour-clinic", "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K")).toBe(
      "Your LUME is ready. Open https://harbour-clinic.lumecrm.in and enter this product key when asked: LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K. It works on one server only, so keep it private.",
    );
  });
  it("opens in WhatsApp, to their number when there is one (digits only)", () => {
    expect(whatsappLink("Hi there", "+971 50 123 4567")).toBe("https://wa.me/971501234567?text=Hi%20there");
    expect(whatsappLink("Hi & bye")).toBe("https://wa.me/?text=Hi%20%26%20bye");
  });
});
