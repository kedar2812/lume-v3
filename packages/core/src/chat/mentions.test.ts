import { describe, expect, it } from "vitest";
import { decodeMentions, encodeMentions, keepPicked, mentionsOf, partsOf, plainOf } from "./mentions";

const A = "0190e0c0-0000-7000-8000-00000000020a";
const B = "0190e0c0-0000-7000-8000-00000000020b";

describe("a message's words", () => {
  it("names people, teams and the channel, each once", () => {
    expect(mentionsOf(`<@${A}> and <@${A}>, <@team:${B}> <@channel>`)).toEqual({
      people: [A],
      teams: [B],
      channel: true,
    });
  });
  it("angle brackets typed by hand are words like any other", () => {
    for (const s of ["<@>", "<@maya>", "<@team:x>", `<@${A}`, "a < b > c", "<@CHANNEL>"])
      expect(partsOf(s)).toEqual([{ t: "text", s }]);
  });
  it("inside code nobody is named", () => {
    expect(mentionsOf(`\`<@${A}>\` and \`<@channel>\``)).toEqual({ people: [], teams: [], channel: false });
  });
  it("bold, italic, code and links; nothing else changes", () => {
    expect(partsOf("*bold* _slanted_ `x=1` https://example.com/a?b=1.")).toEqual([
      { t: "bold", s: "bold" },
      { t: "text", s: " " },
      { t: "italic", s: "slanted" },
      { t: "text", s: " " },
      { t: "code", s: "x=1" },
      { t: "text", s: " " },
      { t: "link", s: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { t: "text", s: "." },
    ]);
    for (const s of [
      "2*3*4",
      "snake_case_name",
      "* not a list *",
      "a * b * c",
      "_ _",
      "नाम_का_मतलब",
      "का_नाम_का",
    ])
      expect(partsOf(s)).toEqual([{ t: "text", s }]);
  });
  it("a link keeps the bracket it opened and leaves the one it didn't", () => {
    expect(partsOf("(see https://example.com/x)")[1]).toMatchObject({ href: "https://example.com/x" });
    expect(partsOf("https://example.com/a_(b)")[0]).toMatchObject({ href: "https://example.com/a_(b)" });
  });
  it("only http and https are links", () => {
    for (const s of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "https://"])
      expect(partsOf(s).some((p) => p.t === "link")).toBe(false);
  });
  it("every character is kept: the parts' words make up the message", () => {
    const s = "Hi *all* 🎉 یہ _پیغام_ `c` http://a.b/c, ok";
    expect(plainOf(s, () => null)).toBe("Hi all 🎉 یہ پیغام c http://a.b/c, ok");
  });
  it("a notice says names, and never an id", () => {
    expect(plainOf(`<@${A}> <@${B}> <@team:${B}>`, (_, id) => (id === A ? "Maya Kapoor" : null))).toBe(
      "@Maya Kapoor @someone @a team",
    );
  });
  it("4,000 characters of marks are read at once", () => {
    const t0 = performance.now();
    for (const s of [
      "*".repeat(4000),
      "_a".repeat(2000),
      "`".repeat(4000),
      "<@".repeat(2000),
      "https://".repeat(500),
      "*a ".repeat(1333),
      `http://x${")".repeat(3990)}`,
      `http://x${".)".repeat(1990)}`,
    ])
      partsOf(s);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe("writing names", () => {
  const maya = { label: "@Maya Kapoor", token: `<@${A}>` };
  const short = { label: "@Maya", token: `<@${B}>` };
  it("a name chosen becomes whom it names, the longest first; one only typed stays words", () => {
    expect(encodeMentions("Ask @Maya Kapoor, then @Maya.", [short, maya])).toBe(`Ask <@${A}>, then <@${B}>.`);
    expect(encodeMentions("Ask @Maya Kapoor", [])).toBe("Ask @Maya Kapoor");
    expect(encodeMentions("@Mayank me@Maya x@Maya Kapoor", [short, maya])).toBe(
      "@Mayank me@Maya x@Maya Kapoor",
    );
    expect(encodeMentions("taken out", [maya])).toBe("taken out");
  });
  it("two people of one name, in the order chosen; more of it are the last", () => {
    const other = { label: "@Maya", token: `<@${A}>` };
    expect(encodeMentions("@Maya @Maya @Maya", [short, other])).toBe(`<@${B}> <@${A}> <@${A}>`);
  });
  it("changing a message shows names, and saving it untouched is the same message", () => {
    const body = `Hi <@${A}> and <@team:${B}>, <@channel>! <@not-one>`;
    const d = decodeMentions(body, (t, id) => (t === "person" && id === A ? "Maya Kapoor" : "Closers"));
    expect(d.text).toBe("Hi @Maya Kapoor and @Closers, @channel! <@not-one>");
    expect(encodeMentions(d.text, d.picked)).toBe(body);
    const gone = decodeMentions(`<@${A}> <@team:${B}>`, () => null);
    expect(gone.text).toBe("@someone @a team");
    expect(encodeMentions(gone.text, gone.picked)).toBe(`<@${A}> <@team:${B}>`);
  });
  it("a name with marks, brackets or another script is only itself", () => {
    for (const label of ["@A.B (Ops)", "@नेहा शर्मा", "@علی", "@$&"]) {
      const p = { label, token: `<@${A}>` };
      expect(encodeMentions(`${label} ok`, [p])).toBe(`<@${A}> ok`);
    }
  });
});

describe("what the review found (2026-11-25)", () => {
  it("a name inside bold or italic marks is still named, and never shown as an id", () => {
    for (const s of [`*Hey <@${A}> please*`, `_<@${A}>_`, `*<@${A}>*`, `*a* <@${A}> *b*`]) {
      expect(mentionsOf(s).people).toEqual([A]);
      expect(partsOf(s).every((p) => !("s" in p) || !p.s.includes(A))).toBe(true);
    }
    expect(partsOf("*a < b*")).toEqual([{ t: "bold", s: "a < b" }]);
  });
  it("a name chosen and put in code stays as it's typed", () => {
    const maya = { label: "@Maya", token: `<@${A}>` };
    expect(encodeMentions("`@Maya` and @Maya", [maya])).toBe(`\`@Maya\` and <@${A}>`);
    expect(encodeMentions("a ` b @Maya", [maya])).toBe(`a \` b <@${A}>`);
    const d = decodeMentions(`\`<@${A}>\` <@${A}>`, () => "Maya");
    expect(d).toEqual({ text: `\`<@${A}>\` @Maya`, picked: [maya] });
  });
  it("two of one name, the first taken out: the second is who's left", () => {
    const [a, b] = [
      { label: "@Rahul Mehta", token: `<@${A}>` },
      { label: "@Rahul Mehta", token: `<@${B}>` },
    ];
    const two = "@Rahul Mehta and @Rahul Mehta";
    expect(keepPicked(two, " and @Rahul Mehta", 0, [a, b])).toEqual([b]);
    expect(keepPicked(two, "@Rahul Mehta and ", 17, [a, b])).toEqual([a]);
    expect(keepPicked(two, "@Rahul Meht and @Rahul Mehta", 11, [a, b])).toEqual([b]);
    expect(keepPicked(two, `${two}!`, two.length + 1, [a, b])).toEqual([a, b]);
    expect(keepPicked(two, "", 0, [a, b])).toEqual([]);
    expect(keepPicked("x", "xy", 2, [])).toEqual([]);
    // The same words left either way: the caret says which went.
    expect(keepPicked("@Rahul Mehta @Rahul Mehta ", "@Rahul Mehta ", 0, [a, b])).toEqual([b]);
    expect(keepPicked("@Rahul Mehta @Rahul Mehta ", "@Rahul Mehta ", 13, [a, b])).toEqual([a]);
    // Another being written right against it doesn't undo it meanwhile.
    expect(keepPicked("@Rahul Mehta ", "@r@Rahul Mehta ", 2, [a])).toEqual([a]);
  });
});
