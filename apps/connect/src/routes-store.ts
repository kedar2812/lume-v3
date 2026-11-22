import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The relay's Instagram routing table (NEW_FEATURES_PLAN §4.2). Instagram Login has one webhook address for the whole
 * app, so the relay must know which client's LUME each connected account belongs to: account id → instance id, and
 * nothing else about it. Beside it, notes an instance must act on when it's back: a gap in deliveries (accounts and a
 * time span), or Meta's deauthorize / data deletion request for a person (their Instagram user id). Never a message.
 *
 * Kept in memory and written through to one JSON file (temp file + rename, so a crash never leaves half a file). A
 * missing or unreadable file starts empty: the relay rebuilds routes by asking each instance on start.
 */
export type RelayNote =
  | { id: string; kind: "gap"; accountIds: string[]; from: number; to: number }
  | { id: string; kind: "delete" | "deauthorize"; userId: string; at: number };
type NoteInput = { kind: "delete" | "deauthorize"; userId: string };

export type RouteStore = {
  get(accountId: string): string | undefined;
  /** Routes the account to the instance; answers the instance it was taken from, if another. */
  set(accountId: string, instanceId: string): string | undefined;
  /** Removes the route only when that instance holds it. */
  drop(accountId: string, instanceId: string): boolean;
  /** The instance holds exactly these accounts (from its own list); another instance's routes are never taken. */
  replaceFor(instanceId: string, accountIds: string[]): void;
  /**
   * Every LUME that holds or held the account (newest first, at most 3): Meta's deauthorize and deletion requests for
   * it go to each, so one that arrives after a disconnect or a move still reaches the LUME that kept its data.
   */
  holders(accountId: string): string[];
  /** Accounts the instance holds. */
  accountsOf(instanceId: string): string[];
  size(): number;
  /** A span the instance missed: joined to its last gap when they touch (a streak of failures). */
  gap(instanceId: string, accountIds: string[], from: number, to: number): void;
  note(instanceId: string, n: NoteInput): void;
  notesFor(instanceId: string): RelayNote[];
  /** Removes the instance's own notes with these ids; answers how many went. */
  clear(instanceId: string, ids: string[]): number;
};

const MAX_NOTES = 2_000;
/** A new failure within this long of a gap's end belongs to the same gap. */
const JOIN_MS = 20 * 60_000;
const WRITE_GAP_MS = 60_000;

type Shape = {
  routes: Record<string, string>;
  notes: Record<string, RelayNote[]>;
  /** Who held each account before (no content): where a late deletion request must still go. */
  formerly: Record<string, string[]>;
};
const FORMERLY_MAX = 3;

function read(file: string): Shape {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Shape> | null;
    const routes: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw?.routes ?? {})) if (typeof v === "string") routes[k] = v;
    const notes: Record<string, RelayNote[]> = {};
    if (raw?.notes && typeof raw.notes === "object" && !Array.isArray(raw.notes))
      for (const [k, v] of Object.entries(raw.notes)) if (Array.isArray(v)) notes[k] = v;
    const formerly: Record<string, string[]> = {};
    if (raw?.formerly && typeof raw.formerly === "object" && !Array.isArray(raw.formerly))
      for (const [k, v] of Object.entries(raw.formerly))
        if (Array.isArray(v))
          formerly[k] = v.filter((x): x is string => typeof x === "string").slice(0, FORMERLY_MAX);
    return { routes, notes, formerly };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(
        "instagram routes: the file couldn't be read; starting empty and rebuilding from instances",
      );
    return { routes: {}, notes: {}, formerly: {} };
  }
}

export function createRouteStore(
  file: string,
  now: () => number = Date.now,
  o: { maxNotes?: number } = {},
): RouteStore {
  const maxNotes = o.maxNotes ?? MAX_NOTES;
  const data = read(file);
  /** When a growing gap was last written: a long outage writes the file once a minute, not on every delivery. */
  let gapWrittenAt = 0;
  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const list = (instanceId: string) => (data.notes[instanceId] ??= []);
  const bound = (instanceId: string) => {
    const l = list(instanceId);
    // The oldest gaps go first; a person's deletion or deauthorize request is never dropped.
    while (l.length > maxNotes) {
      const i = l.findIndex((n) => n.kind === "gap");
      if (i < 0) break;
      l.splice(i, 1);
    }
  };
  const newId = () => randomBytes(9).toString("base64url");
  const remember = (a: string, inst: string) => {
    data.formerly[a] = [inst, ...(data.formerly[a] ?? []).filter((x) => x !== inst)].slice(0, FORMERLY_MAX);
  };

  return {
    get: (a) => data.routes[a],
    set(a, inst) {
      const was = data.routes[a];
      if (was === inst) return undefined;
      if (was) remember(a, was);
      data.routes[a] = inst;
      write();
      return was;
    },
    drop(a, inst) {
      if (data.routes[a] !== inst) return false;
      delete data.routes[a];
      remember(a, inst);
      write();
      return true;
    },
    replaceFor(inst, ids) {
      for (const [a, i] of Object.entries(data.routes)) if (i === inst) delete data.routes[a];
      for (const a of ids) if (!data.routes[a]) data.routes[a] = inst;
      write();
    },
    holders: (a) => [...new Set([...(data.routes[a] ? [data.routes[a]] : []), ...(data.formerly[a] ?? [])])],
    accountsOf: (inst) =>
      Object.entries(data.routes)
        .filter(([, i]) => i === inst)
        .map(([a]) => a),
    size: () => Object.keys(data.routes).length,
    gap(inst, accountIds, from, to) {
      const l = list(inst);
      const last = [...l].reverse().find((n) => n.kind === "gap");
      if (last && last.kind === "gap" && from <= last.to + JOIN_MS && to >= last.from) {
        const before = last.accountIds.length;
        last.from = Math.min(last.from, from);
        last.to = Math.max(last.to, to);
        last.accountIds = [...new Set([...last.accountIds, ...accountIds])];
        // Only a later end: held in memory, written within the minute (a crash loses at most that much of the end,
        // and the catch-up reads Meta's newest messages anyway). A new account is written at once.
        if (last.accountIds.length === before && now() - gapWrittenAt < WRITE_GAP_MS) return;
      } else l.push({ id: newId(), kind: "gap", accountIds: [...new Set(accountIds)], from, to });
      bound(inst);
      gapWrittenAt = now();
      write();
    },
    note(inst, n) {
      list(inst).push({ id: newId(), kind: n.kind, userId: n.userId, at: now() });
      bound(inst);
      write();
    },
    notesFor: (inst) => [...(data.notes[inst] ?? [])],
    clear(inst, ids) {
      const l = data.notes[inst];
      if (!l) return 0;
      const want = new Set(ids);
      const keep = l.filter((n) => !want.has(n.id));
      const gone = l.length - keep.length;
      if (gone) {
        data.notes[inst] = keep;
        write();
      }
      return gone;
    },
  };
}
