import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRouteStore } from "./routes-store";

/** The relay's Instagram routing table (NEW_FEATURES_PLAN §4.2; plan 1A Task 2): which LUME an account belongs to. */
let dir: string;
let file: string;
let t = 1_000;
const now = () => t;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-routes-"));
  file = path.join(dir, "instagram-routes.json");
  t = 1_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the routing table", () => {
  it("is kept on disk: a new store reads what the last one wrote", () => {
    const a = createRouteStore(file, now);
    a.set("acct1", "instA");
    a.set("acct2", "instB");
    const b = createRouteStore(file, now);
    expect(b.get("acct1")).toBe("instA");
    expect(b.get("acct2")).toBe("instB");
    expect(b.size()).toBe(2);
  });

  it("set answers the instance it took the account from", () => {
    const s = createRouteStore(file, now);
    expect(s.set("acct1", "instA")).toBeUndefined();
    expect(s.set("acct1", "instA")).toBeUndefined();
    expect(s.set("acct1", "instB")).toBe("instA");
    expect(s.get("acct1")).toBe("instB");
  });

  it("drop only removes an account the asking instance holds", () => {
    const s = createRouteStore(file, now);
    s.set("acct1", "instA");
    expect(s.drop("acct1", "instB")).toBe(false);
    expect(s.get("acct1")).toBe("instA");
    expect(s.drop("acct1", "instA")).toBe(true);
    expect(s.get("acct1")).toBeUndefined();
    expect(createRouteStore(file, now).get("acct1")).toBeUndefined();
  });

  it("replaceFor sets an instance's accounts to exactly its list, and never takes another's", () => {
    const s = createRouteStore(file, now);
    s.set("old", "instA");
    s.set("theirs", "instB");
    s.replaceFor("instA", ["new1", "new2", "theirs"]);
    expect(s.get("old")).toBeUndefined();
    expect(s.get("new1")).toBe("instA");
    expect(s.get("theirs")).toBe("instB");
  });

  it("a missing, empty or corrupt file starts empty and never throws", () => {
    expect(createRouteStore(path.join(dir, "none.json"), now).size()).toBe(0);
    fs.writeFileSync(file, "");
    expect(createRouteStore(file, now).size()).toBe(0);
    fs.writeFileSync(file, "{not json");
    expect(createRouteStore(file, now).size()).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ routes: { a: 5 }, notes: "x" }));
    const s = createRouteStore(file, now);
    expect(s.get("a")).toBeUndefined();
    s.set("b", "inst");
    expect(createRouteStore(file, now).get("b")).toBe("inst");
  });

  it("never leaves a temp file behind", () => {
    const s = createRouteStore(file, now);
    for (let i = 0; i < 50; i++) s.set(`acct${i}`, "inst");
    expect(fs.readdirSync(dir)).toEqual(["instagram-routes.json"]);
  });
});

describe("notes (no message content, only what an instance must catch up on)", () => {
  it("a gap is extended while the same instance keeps failing, and joins its accounts", () => {
    const s = createRouteStore(file, now);
    s.gap("instA", ["a1"], 1_000, 2_000);
    s.gap("instA", ["a2"], 1_000, 5_000);
    const notes = s.notesFor("instA");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "gap", accountIds: ["a1", "a2"], from: 1_000, to: 5_000 });
  });

  it("a long outage writes its growing gap at most once a minute, a new account at once", () => {
    const s = createRouteStore(file, now);
    s.gap("instA", ["a1"], 1_000, 2_000);
    const written = () => createRouteStore(file, now).notesFor("instA")[0];
    t = 10_000;
    s.gap("instA", ["a1"], 1_000, 10_000);
    expect(written()).toMatchObject({ to: 2_000 });
    s.gap("instA", ["a2"], 1_000, 11_000);
    expect(written()).toMatchObject({ to: 11_000, accountIds: ["a1", "a2"] });
    t = 80_000;
    s.gap("instA", ["a1"], 1_000, 80_000);
    expect(written()).toMatchObject({ to: 80_000 });
    expect(s.notesFor("instA")[0]).toMatchObject({ to: 80_000 });
  });

  it("a gap after a recovery is a new gap", () => {
    const s = createRouteStore(file, now);
    s.gap("instA", ["a1"], 1_000, 2_000);
    s.gap("instA", ["a1"], 50_000_000, 60_000_000);
    expect(s.notesFor("instA")).toHaveLength(2);
  });

  it("each instance sees only its own notes, and clears only its own", () => {
    const s = createRouteStore(file, now);
    s.gap("instA", ["a1"], 1, 2);
    s.note("instB", { kind: "delete", userId: "u1" });
    expect(s.notesFor("instA").map((n) => n.kind)).toEqual(["gap"]);
    const [b] = s.notesFor("instB");
    expect(s.clear("instA", [b!.id])).toBe(0);
    expect(s.notesFor("instB")).toHaveLength(1);
    expect(s.clear("instB", [b!.id])).toBe(1);
    expect(s.notesFor("instB")).toHaveLength(0);
  });

  it("are kept on disk", () => {
    const s = createRouteStore(file, now);
    s.note("instA", { kind: "deauthorize", userId: "u9" });
    expect(createRouteStore(file, now).notesFor("instA")[0]).toMatchObject({
      kind: "deauthorize",
      userId: "u9",
    });
  });

  it("are bounded: past the cap the oldest gaps go first, never a deletion request", () => {
    const s = createRouteStore(file, now, { maxNotes: 50 });
    s.note("instA", { kind: "delete", userId: "keep-me" });
    for (let i = 0; i < 80; i++) s.gap("instA", [`a${i}`], i * 100_000_000, i * 100_000_000 + 1);
    const notes = s.notesFor("instA");
    expect(notes).toHaveLength(50);
    expect(notes.at(-1)).toMatchObject({ kind: "gap", accountIds: ["a79"] });
    expect(notes.some((n) => n.kind === "delete" && n.userId === "keep-me")).toBe(true);
  });
});
