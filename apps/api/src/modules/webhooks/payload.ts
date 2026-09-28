type Json = Record<string, unknown>;
/** Deeper than this, a value is listed as one LUME can't map, rather than walked. */
const MAX_DEPTH = 5;

export type ParsedBody =
  | { ok: true; value: Json }
  | { ok: false; status: 400 | 415; code: "BAD_JSON" | "NOT_OBJECT" | "UNSUPPORTED_TYPE" };

/** 2C spec §4 step 4: JSON (an object at the top), or a plain HTML form. Anything else is refused. */
export function parseBody(raw: Buffer, contentType: string | undefined): ParsedBody {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded")
    return { ok: true, value: Object.fromEntries(new URLSearchParams(raw.toString("utf8"))) };
  if (type !== "application/json") return { ok: false, status: 415, code: "UNSUPPORTED_TYPE" };
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, status: 400, code: "BAD_JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, status: 400, code: "NOT_OBJECT" };
  return { ok: true, value: v as Json };
}

const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/** A payload as cells by path (2C spec §2 "Nested values"): one value per path, or listed as unmappable. */
export function flatten(value: Json): { cells: Map<string, string>; unmappable: string[] } {
  const cells = new Map<string, string>();
  const unmappable: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (scalar(v)) return void cells.set(path, text(v));
    if (Array.isArray(v)) {
      if (v.every(scalar)) return void cells.set(`${path}[]`, v.map(text).filter(Boolean).join(", "));
      return void unmappable.push(path);
    }
    if (v && typeof v === "object") {
      if (depth >= MAX_DEPTH) return void unmappable.push(path);
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(value, "", 0);
  return { cells, unmappable };
}

export const pathsOf = (value: Json): string[] => [...flatten(value).cells.keys()];

/** A post's cells in the saved headers' order, so the intake engine reads it like a sheet row. */
export const cellsFor = (headers: string[], cells: Map<string, string>): string[] =>
  headers.map((h) => cells.get(h) ?? "");
