import { describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "./queues";

describe("QUEUE_NAMES", () => {
  it("lists every queue exactly once: ops, then imports, then sheets", () => {
    expect(QUEUE_NAMES).toEqual([
      "ops.backup",
      "ops.restore-test",
      "ops.idempotency-cleanup",
      "imports.run",
      "imports.retention",
      "bulk.run",
      "sheets.sync",
      "sheets.retention",
      "calendar.sync",
      "live-sheets.run",
      "webhooks.process",
      "webhooks.retention",
      "tasks.fire",
      "notifications.retention",
      "whatsapp.process",
      "whatsapp.media",
      "whatsapp.send",
      "whatsapp.meaning",
      "media.preview",
      "autopilot.step",
      "instagram.process",
      "instagram.send",
      "instagram.media",
      "instagram.profile",
      "instagram.public",
      "instagram.photo",
      "instagram.account-photo",
      "storage.cleanup",
    ]);
    expect(new Set(QUEUE_NAMES).size).toBe(QUEUE_NAMES.length);
  });
});
