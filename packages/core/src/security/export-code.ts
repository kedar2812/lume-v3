/**
 * Phase 6B: what makes a lead export traceable (spec §3). Pure; the API makes and checks the files.
 * The code goes on every row (`LUME ref`); the check row is one made-up lead hidden in the file.
 */

/** No 0/O, 1/I/L: a code read off a printout or typed back can't be mistaken. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type RandomBytes = (n: number) => Uint8Array;
const cryptoBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** "LX7Q-4MRA": eight characters, the dash for reading. */
export function newExportCode(random: RandomBytes = cryptoBytes): string {
  const b = random(8);
  const c = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** A code however it was typed — lower case, spaces, no dash — as stored; null if it can't be one. */
export function normaliseCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "");
  if (c.length !== 8 || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

// Generic, fictional names (CLAUDE.md): the check row must read like any other lead.
const FIRST = [
  "Ana",
  "Ben",
  "Cara",
  "Dev",
  "Ella",
  "Farid",
  "Gia",
  "Hugo",
  "Isla",
  "Jon",
  "Kira",
  "Leo",
  "Mira",
  "Nils",
  "Omar",
  "Pia",
  "Rhea",
  "Sam",
  "Tara",
  "Yusuf",
];
const LAST = [
  "Bell",
  "Cole",
  "Dale",
  "Ennis",
  "Ford",
  "Grant",
  "Hale",
  "Iver",
  "Joss",
  "Kemp",
  "Lowe",
  "Marsh",
  "Noor",
  "Oakes",
  "Pryce",
  "Quinn",
  "Reyes",
  "Shaw",
  "Tate",
  "Wade",
];
const pick = (list: string[], b: number) => list[b % list.length]!;

/**
 * The check row's person: a name from the lists, an email at example.invalid (RFC 2606: reserved, it can never
 * receive mail) with a random tag that makes it this export's alone, and a phone in Ofcom's range kept for
 * fiction (+44 7700 900000–900999), so nobody real is ever reached.
 */
export function checkRow(random: RandomBytes = cryptoBytes): { name: string; email: string; phone: string } {
  const b = random(7);
  const first = pick(FIRST, b[0]!);
  const last = pick(LAST, b[1]!);
  const tag = Array.from(b.slice(2, 5), (x) => x.toString(16).padStart(2, "0")).join("");
  const n = ((b[5]! << 8) | b[6]!) % 1000;
  return {
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}.${tag}@example.invalid`,
    phone: `+447700900${String(n).padStart(3, "0")}`,
  };
}

/** A check row's email: nothing real is ever at example.invalid. */
export const isCheckEmail = (email: string | null | undefined): boolean =>
  !!email && /@example\.invalid$/i.test(email.trim());
