import { describe, expect, it } from "vitest";
import { oneAtATime } from "./one-at-a-time";

/** A connection that answers after a moment, noting how many queries it was given at once. */
function connection() {
  let inFlight = 0;
  const seen = { most: 0, order: [] as string[] };
  return {
    seen,
    tag: "the connection itself",
    query(text: string) {
      inFlight++;
      seen.most = Math.max(seen.most, inFlight);
      return new Promise<{ rows: string[] }>((done, fail) =>
        setTimeout(() => {
          inFlight--;
          seen.order.push(text);
          if (text === "fails") fail(new Error("relation does not exist"));
          else done({ rows: [text] });
        }, 5),
      );
    },
    whoAmI(this: { tag: string }) {
      return this.tag;
    },
  };
}

describe("a request's connection takes one query at a time (pg 9 refuses a second while one runs)", () => {
  it("queries asked for together run one after another, in the order asked, each with its own answer", async () => {
    const c = connection();
    const db = oneAtATime(c);
    const answers = await Promise.all([db.query("a"), db.query("b"), db.query("c")]);
    expect(c.seen.most).toBe(1);
    expect(c.seen.order).toEqual(["a", "b", "c"]);
    expect(answers.map((r) => r.rows[0])).toEqual(["a", "b", "c"]);
  });

  it("one that fails doesn't stop the next; its caller still hears the error", async () => {
    const c = connection();
    const db = oneAtATime(c);
    const [bad, good] = await Promise.allSettled([db.query("fails"), db.query("after")]);
    expect(bad.status).toBe("rejected");
    expect(good).toMatchObject({ status: "fulfilled", value: { rows: ["after"] } });
  });

  it("everything else is the connection's own, as before", () => {
    const c = connection();
    expect(oneAtATime(c).whoAmI()).toBe("the connection itself");
  });
});
