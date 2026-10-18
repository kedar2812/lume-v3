import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { metaSignatureOk, relayCheck, relaySign } from "./sign";

/** Who may hand LUME a WhatsApp message: Meta to the relay, the relay to an instance (plan W1 Task 1). */
describe("Meta's signature, as the relay checks it", () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  const right = `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}`;

  it("right, wrong, missing and the wrong length", () => {
    expect(metaSignatureOk("app-secret", raw, right)).toBe(true);
    expect(metaSignatureOk("other-secret", raw, right)).toBe(false);
    expect(metaSignatureOk("app-secret", raw, undefined)).toBe(false);
    expect(metaSignatureOk("app-secret", raw, "sha256=abc")).toBe(false);
    expect(metaSignatureOk("app-secret", Buffer.from(`${raw} `), right)).toBe(false);
  });
});

describe("the relay's forward, as an instance checks it", () => {
  const raw = Buffer.from("{}");
  const now = Date.parse("2026-10-21T06:00:00Z");
  const ts = String(now / 1000);

  it("signed by the relay with this instance's token, within 5 minutes", () => {
    const sig = relaySign("instance-token", ts, raw);
    expect(relayCheck("instance-token", ts, sig, raw, now)).toBe("ok");
    expect(relayCheck("another-token", ts, sig, raw, now)).toBe("bad");
    expect(relayCheck("instance-token", undefined, sig, raw, now)).toBe("bad");
    expect(relayCheck("instance-token", ts, undefined, raw, now)).toBe("bad");
    expect(relayCheck("instance-token", ts, sig, raw, now + 300_000)).toBe("ok");
    expect(relayCheck("instance-token", ts, sig, raw, now + 301_000)).toBe("stale");
  });
});
