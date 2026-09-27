import { describe, expect, it } from "vitest";
import { analyzeColumns, mapRow, resolveColumnSettings, type Mapping, type RowOutcome } from "./index";
import { mapOf, testContext, testRules } from "./test-context";

const draft = (o: RowOutcome) => {
  if (o.kind !== "draft") throw new Error(`expected a draft, got ${JSON.stringify(o)}`);
  return o;
};
const problems = (o: RowOutcome) => (o.kind === "error" ? o.problems.map((p) => p.code) : []);
const warns = (o: RowOutcome) => (o.kind === "empty" ? [] : o.warnings.map((w) => w.code));
const run = (
  keys: (string | null)[],
  cells: string[],
  rules = testRules(),
  ctx = testContext({ headerCount: keys.length }),
) => mapRow(cells, mapOf(keys), rules, ctx);

describe("empty rows and names (§6.1, §6.2, §6.4)", () => {
  it("calls a row with nothing in its mapped cells empty", () => {
    expect(run(["name", "phone", null], ["", "  ", "ignored"]).kind).toBe("empty");
  });

  it("trims and collapses a name, and combines first and last", () => {
    expect(draft(run(["name"], ["  Aisha   Khan "])).draft.name).toBe("Aisha Khan");
    const m: Mapping = {
      columns: [
        { column: 0, to: "name_part", part: "first" },
        { column: 1, to: "name_part", part: "last" },
      ],
      createMissingTags: false,
    };
    expect(draft(mapRow(["Aisha", ""], m, testRules(), testContext({ headerCount: 2 }))).draft.name).toBe(
      "Aisha",
    );
    expect(draft(mapRow(["Aisha", "Khan"], m, testRules(), testContext({ headerCount: 2 }))).draft.name).toBe(
      "Aisha Khan",
    );
  });

  it("uses the contact as the name when there is none, and says so", () => {
    const o = draft(run(["name", "phone", "email"], ["", "0501234567", "a@x.com"]));
    expect(o.draft.name).toBe("+971 50 123 4567");
    expect(o.draft.nameFromContact).toBe(true);
    expect(warns(o)).toContain("NAME_FROM_CONTACT");
    expect(draft(run(["name", "email"], ["", "a@x.com"])).draft.name).toBe("a@x.com");
    expect(draft(run(["name", "instagram"], ["", "@aisha"])).draft.name).toBe("@aisha");
  });

  it("refuses a row with no name and no contact, and no name at all when asked", () => {
    expect(problems(run(["name", "email", "tier"], ["", "", "Gold"]))).toEqual(["NO_NAME_NO_CONTACT"]);
    expect(problems(run(["name", "phone"], ["", "0501234567"], testRules({ noName: "error" })))).toEqual([
      "NO_NAME",
    ]);
    expect(problems(run(["name"], ["x".repeat(201)]))).toEqual(["NAME_TOO_LONG"]);
  });

  it("refuses a cell over 10,000 characters, and warns about extra cells", () => {
    expect(problems(run(["name", "notes"], ["A", "x".repeat(10_001)]))).toContain("CELL_TOO_LONG");
    expect(warns(run(["name"], ["A", "extra", "more"]))).toContain("EXTRA_CELLS");
  });
});

describe("contacts (§6.3)", () => {
  it("normalises phones with the default country, keeping the raw value", () => {
    const o = draft(run(["name", "phone"], ["A", "050 123 4567"]));
    expect(o.draft.phone).toMatchObject({ raw: "050 123 4567", e164: "+971501234567", status: "valid" });
  });

  it("imports unreadable phones with a warning, never an error", () => {
    const o = draft(run(["name", "phone"], ["A", "12345"]));
    expect(o.draft.phone.status).toBe("invalid");
    expect(warns(o)).toContain("PHONE_INVALID");
    const local = draft(
      run(
        ["name", "phone"],
        ["A", "0501234567"],
        testRules({ defaultCountry: null }),
        testContext({ country: null, headerCount: 2 }),
      ),
    );
    expect(local.draft.phone.status).toBe("needs_country");
    expect(warns(local)).toContain("PHONE_NEEDS_COUNTRY");
  });

  it("keeps an Excel-shortened number as invalid, saying exactly what happened", () => {
    const o = draft(run(["name", "phone"], ["A", "9.71501E+11"]));
    expect(o.draft.phone).toMatchObject({ raw: "9.71501E+11", e164: null, status: "invalid" });
    expect(o.warnings.find((w) => w.code === "PHONE_EXCEL")?.message).toMatch(/Excel shortened this number/);
  });

  it("takes the first of several numbers and keeps the rest for the history", () => {
    const o = draft(run(["name", "phone"], ["A", "050 111 2222 / 055 333 4444"]));
    expect(o.draft.phone.e164).toBe("+971501112222");
    expect(o.draft.extraPhones).toEqual(["055 333 4444"]);
    expect(warns(o)).toContain("PHONE_EXTRA");
  });

  it("drops an invalid email or Instagram handle with a warning", () => {
    const o = draft(run(["name", "email", "instagram"], ["A", "not-an-email", "bad handle!"]));
    expect(o.draft.email).toBeNull();
    expect(o.draft.instagram).toBeNull();
    expect(warns(o)).toEqual(expect.arrayContaining(["EMAIL_INVALID", "INSTAGRAM_INVALID"]));
    expect(draft(run(["name", "instagram"], ["A", "instagram.com/Aisha.K"])).draft.instagram).toBe("aisha.k");
  });
});

describe("stage, owner, lost reason (§6.5, §6.6)", () => {
  it("matches a stage by name within the pipeline, ignoring case and spaces", () => {
    const o = draft(run(["name", "stage"], ["A", "  call   BOOKED "]));
    expect(o.draft).toMatchObject({ stageId: "s-booked", stageKind: "open" });
  });

  it("refuses an unknown stage by name", () => {
    const o = run(["name", "stage"], ["A", "Proposal"]);
    expect(o.kind === "error" && o.problems[0]!.message).toBe("No stage called “Proposal” in this pipeline.");
  });

  it("uses a value map for stages", () => {
    const m = mapOf(["name", "stage"]);
    m.columns[1] = {
      column: 1,
      to: "field",
      field: "stage",
      transform: { valueMap: { proposal: "Call booked", junk: null } },
    };
    expect(
      draft(mapRow(["A", "Proposal"], m, testRules(), testContext({ headerCount: 2 }))).draft.stageId,
    ).toBe("s-booked");
    expect(
      draft(mapRow(["A", "junk"], m, testRules(), testContext({ headerCount: 2 }))).draft.stageId,
    ).toBeNull();
  });

  it("keeps a lost reason only on a Lost stage", () => {
    expect(draft(run(["name", "stage", "lost_reason"], ["A", "Lost", "price"])).draft.lostReasonId).toBe(
      "r-price",
    );
    const o = draft(run(["name", "stage", "lost_reason"], ["A", "New", "Price"]));
    expect(o.draft.lostReasonId).toBeNull();
    expect(warns(o)).toContain("LOST_REASON_IGNORED");
    expect(problems(run(["name", "stage", "lost_reason"], ["A", "Lost", "Too far"]))).toContain(
      "LOST_REASON_UNKNOWN",
    );
  });

  it("matches an owner by email, or by a name only one active person has", () => {
    expect(draft(run(["name", "owner"], ["A", "RIYA@brightpath.test"])).draft.ownerId).toBe("u-riya");
    expect(draft(run(["name", "owner"], ["A", "riya sharma"])).draft.ownerId).toBe("u-riya");
    expect(problems(run(["name", "owner"], ["A", "Sam Lee"]))).toEqual(["OWNER_AMBIGUOUS"]);
  });

  it("falls back to the owner rule for an unknown or disabled owner, or refuses when asked", () => {
    const o = draft(run(["name", "owner"], ["A", "Omar Gone"]));
    expect(o.draft.ownerId).toBeUndefined();
    expect(warns(o)).toContain("OWNER_UNKNOWN");
    expect(problems(run(["name", "owner"], ["A", "Nobody"], testRules({ unknownOwner: "error" })))).toEqual([
      "OWNER_UNKNOWN",
    ]);
  });

  it("an importer who can't assign may only own leads themselves", () => {
    const c = testContext({ canAssign: false, headerCount: 2 });
    expect(problems(run(["name", "owner"], ["A", "Riya Sharma"], testRules(), c))).toEqual(["CANNOT_ASSIGN"]);
    expect(draft(run(["name", "owner"], ["A", "maya@brightpath.test"], testRules(), c)).draft.ownerId).toBe(
      "u-me",
    );
  });

  it("leaves the owner to the rule when the cell is empty", () => {
    expect(draft(run(["name", "owner"], ["A", ""])).draft.ownerId).toBeUndefined();
  });
});

describe("dates and money (§6.7, §6.8)", () => {
  it("reads the created date with the column's order", () => {
    const c = testContext({ headerCount: 2, dateOrders: { 1: "DMY" } });
    expect(
      draft(run(["name", "lead_created_at"], ["A", "04/03/2026"], testRules(), c)).draft.leadCreatedAt,
    ).toBe("2026-03-04");
    expect(problems(run(["name", "lead_created_at"], ["A", "30/09/2026"], testRules(), c))).toEqual([
      "DATE_FUTURE",
    ]);
  });

  it("reads the value in the business currency, and refuses another", () => {
    const c = testContext({ headerCount: 2, decimalMarks: { 1: "." } });
    expect(draft(run(["name", "value"], ["A", "AED 4,500"], testRules(), c)).draft.value).toBe(4500);
    expect(problems(run(["name", "value"], ["A", "$4,500"], testRules(), c))).toEqual(["FOREIGN_CURRENCY"]);
  });

  it("reads a datetime field as an instant", () => {
    const c = testContext({ headerCount: 2, dateOrders: { 1: "YMD" } });
    expect(
      draft(run(["name", "call_at"], ["A", "2026-03-04 10:30"], testRules(), c)).draft.custom.call_at,
    ).toBe("2026-03-04T06:30:00.000Z");
  });
});

describe("custom fields (§6.8)", () => {
  it("matches options by label, ignoring case and accents, never an archived one", () => {
    expect(draft(run(["name", "tier"], ["A", " gold "])).draft.custom.tier).toBe("o-gold");
    expect(problems(run(["name", "tier"], ["A", "Bronze"]))).toEqual(["OPTION_UNKNOWN"]);
  });

  it("splits multi-choice values and de-duplicates them", () => {
    expect(
      draft(run(["name", "struggles"], ["A", "Confidence; career switch, confidence"])).draft.custom
        .struggles,
    ).toEqual(["o-conf", "o-career"]);
  });

  it("reads yes/no, and refuses anything else", () => {
    expect(draft(run(["name", "paid"], ["A", "Y"])).draft.custom.paid).toBe(true);
    expect(problems(run(["name", "paid"], ["A", "maybe"]))).toEqual(["NOT_YES_NO"]);
  });

  it("drops an invalid link or phone in a custom field with a warning", () => {
    const o = draft(run(["name", "website", "alt_phone"], ["A", "not a link", "123"]));
    expect(o.draft.custom).toEqual({});
    expect(warns(o)).toEqual(expect.arrayContaining(["URL_INVALID", "PHONE_INVALID"]));
  });

  it("matches person fields like owners, with no fallback", () => {
    expect(draft(run(["name", "coach"], ["A", "Riya Sharma"])).draft.custom.coach).toBe("u-riya");
    expect(problems(run(["name", "coach"], ["A", "Nobody"]))).toEqual(["PERSON_UNKNOWN"]);
  });

  it("refuses text longer than the field allows", () => {
    expect(problems(run(["name", "website"], ["A", `https://x.test/${"a".repeat(2000)}`]))).toContain(
      "VALUE_TOO_LONG",
    );
  });

  it("fills required fields from the rules' defaults, or refuses the row (spec amendment 3)", () => {
    const c = testContext({
      headerCount: 1,
      fields: testContext().fields.map((x) => (x.key === "tier" ? { ...x, isRequired: true } : x)),
    });
    expect(problems(run(["name"], ["A"], testRules(), c))).toEqual(["REQUIRED_MISSING"]);
    expect(
      draft(run(["name"], ["A"], testRules({ requiredDefaults: { tier: "o-silver" } }), c)).draft.custom.tier,
    ).toBe("o-silver");
  });
});

describe("tags", () => {
  it("matches tags by label, and refuses unknown ones (they're created at Start when chosen)", () => {
    expect(draft(run(["name", "tags"], ["A", "hot, VIP, Hot"])).draft.tagIds).toEqual(["t-hot", "t-vip"]);
    expect(problems(run(["name", "tags"], ["A", "Cold"]))).toEqual(["TAG_UNKNOWN"]);
  });
});

describe("analyzeColumns and resolveColumnSettings", () => {
  const rows = [
    ["A", "13/03/2026", "Gold", "1.234,50", "Proposal"],
    ["B", "04/03/2026", "Platinum", "99,00", "New"],
    ["C", "05/03/2026", "Platinum", "12", "Proposal"],
  ];
  const m = mapOf(["name", "lead_created_at", "tier", "value", "stage"]);
  const c = testContext({ headerCount: 5 });

  it("finds each column's date order, decimal mark and unmatched values with counts", () => {
    const a = analyzeColumns(rows, m, c);
    expect(a[1]).toMatchObject({ dateOrder: "DMY" });
    expect(a[2]!.unmatched).toEqual([{ value: "Platinum", rows: 2 }]);
    expect(a[3]).toMatchObject({ decimalMark: "," });
    expect(a[4]!.unmatched).toEqual([{ value: "Proposal", rows: 2 }]);
  });

  it("blocks on a conflicting date column until the importer chooses, and defaults an ambiguous one", () => {
    const conflicted = analyzeColumns(
      [
        ["A", "13/03/2026"],
        ["B", "03/13/2026"],
      ],
      mapOf(["name", "lead_created_at"]),
      testContext({ headerCount: 2 }),
    );
    expect(
      resolveColumnSettings(conflicted, mapOf(["name", "lead_created_at"]), { country: "AE" }).blocking.map(
        (b) => b.code,
      ),
    ).toEqual(["DATE_ORDER_NEEDED"]);
    const chosen = mapOf(["name", "lead_created_at"]);
    chosen.columns[1] = { column: 1, to: "field", field: "lead_created_at", transform: { dateOrder: "MDY" } };
    expect(resolveColumnSettings(conflicted, chosen, { country: "AE" })).toMatchObject({
      dateOrders: { 1: "MDY" },
      blocking: [],
    });
    const ambiguous = analyzeColumns(
      [["A", "03/04/2026"]],
      mapOf(["name", "lead_created_at"]),
      testContext({ headerCount: 2 }),
    );
    expect(
      resolveColumnSettings(ambiguous, mapOf(["name", "lead_created_at"]), { country: "US" }).dateOrders,
    ).toEqual({ 1: "MDY" });
  });

  it("treats an option chosen to be added as matched", () => {
    const adding = {
      ...mapOf(["name", "lead_created_at", "tier", "value", "stage"]),
      addOptions: { tier: ["Platinum"] },
    };
    expect(analyzeColumns(rows, adding, c)[2]!.unmatched).toEqual([]);
  });

  it("treats a value mapped in the unmatched panel as matched", () => {
    const mapped = mapOf(["name", "lead_created_at", "tier", "value", "stage"]);
    mapped.columns[2] = {
      column: 2,
      to: "field",
      field: "tier",
      transform: { valueMap: { platinum: "Gold" } },
    };
    expect(analyzeColumns(rows, mapped, c)[2]!.unmatched).toEqual([]);
  });
});
