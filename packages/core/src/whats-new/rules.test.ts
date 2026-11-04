import { describe, expect, it } from "vitest";
import { RELEASES, type Release } from "./releases";
import { EMPTY_WHATS_NEW, isNew, releaseFor, storiesFor, windowDue } from "./rules";

const all = { can: () => true, on: { ai: true, whatsapp: true } };
const r = RELEASES[0] as Release;
const DAY = 86_400_000;

describe("the releases", () => {
  it("1.2.0 comes first, from 1.1.0, with three stories that fit the window", () => {
    expect(r.version).toBe("1.2.0");
    expect(r.from).toBe("1.1.0");
    expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.stories.map((s) => s.id)).toEqual(["calls", "chats", "templates"]);
    for (const s of r.stories) {
      expect(s.ms).toBeGreaterThanOrEqual(7000);
      expect(s.ms).toBeLessThanOrEqual(9000);
      for (const line of s.head) expect(line.length).toBeLessThanOrEqual(18);
    }
    expect(r.alsoNew).toHaveLength(4);
  });

  it("no string speaks with an em dash or a 'we'", () => {
    const words = JSON.stringify(RELEASES);
    expect(words).not.toContain("—");
    expect(words).not.toMatch(/\bwe\b/i);
  });

  it("releaseFor matches the version exactly", () => {
    expect(releaseFor("1.2.0")?.version).toBe("1.2.0");
    expect(releaseFor("1.2")).toBeNull();
    expect(releaseFor("9.9.9")).toBeNull();
  });
});

describe("storiesFor", () => {
  it("drops a story whose place the person can't open", () => {
    const ids = storiesFor(r, { ...all, can: (p) => p !== "settings.manage" }).map((s) => s.id);
    expect(ids).toEqual(["chats", "templates"]);
  });
  it("drops WhatsApp's story when WhatsApp is off", () => {
    expect(storiesFor(r, { ...all, on: { ai: true, whatsapp: false } }).map((s) => s.id)).toEqual(["calls", "templates"]);
  });
  it("drops LUME AI's stories when LUME AI is off", () => {
    expect(storiesFor(r, { ...all, on: { ai: false, whatsapp: true } }).map((s) => s.id)).toEqual(["chats"]);
  });
});

describe("windowDue", () => {
  const base = {
    state: { ...EMPTY_WHATS_NEW, seen: "1.1.0" },
    release: r,
    stories: r.stories,
    joinedAt: new Date("2026-10-01T00:00:00Z"),
  };
  it("is due for someone who last saw 1.1.0 and joined before the release", () => {
    expect(windowDue(base)).toBe(true);
    expect(windowDue({ ...base, state: EMPTY_WHATS_NEW })).toBe(true);
  });
  it("isn't due once this version is seen", () => {
    expect(windowDue({ ...base, state: { ...base.state, seen: r.version } })).toBe(false);
  });
  it("isn't due with no story left for them", () => {
    expect(windowDue({ ...base, stories: [] })).toBe(false);
  });
  it("isn't due for someone who joined on or after the release day", () => {
    expect(windowDue({ ...base, joinedAt: new Date(`${r.date}T00:00:00Z`) })).toBe(false);
    expect(windowDue({ ...base, joinedAt: new Date(Date.parse(`${r.date}T00:00:00Z`) - 1) })).toBe(true);
  });
  it("isn't due when the running version has no release", () => {
    expect(windowDue({ ...base, release: null })).toBe(false);
  });
});

describe("isNew", () => {
  const start = Date.parse(`${r.date}T00:00:00Z`);
  it("is new for a week from the release day", () => {
    expect(isNew({ state: EMPTY_WHATS_NEW, release: r, story: "calls", now: new Date(start + 7 * DAY - 3_600_000) })).toBe(true);
    expect(isNew({ state: EMPTY_WHATS_NEW, release: r, story: "calls", now: new Date(start + 7 * DAY) })).toBe(false);
  });
  it("isn't new once used", () => {
    const state = { ...EMPTY_WHATS_NEW, used: ["1.2.0:calls"] };
    expect(isNew({ state, release: r, story: "calls", now: new Date(start + DAY) })).toBe(false);
    expect(isNew({ state, release: r, story: "chats", now: new Date(start + DAY) })).toBe(true);
  });
});
