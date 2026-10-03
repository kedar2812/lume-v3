/** What a search term will look at, as the API decides it (7A): said inside the search field as you type (7C). */
export type SearchMode = {
  label: string;
  tone: "wait" | "prefix" | "inside" | "names";
  searches: boolean;
  /** A short line under the field, only when the term doesn't search yet. */
  tip?: string;
};

export function searchMode(raw: string, contactsVisible: boolean): SearchMode | null {
  const t = raw.trim();
  if (!t) return null;
  const chars = [...t].length;
  const meaningful = [...t].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  if (!meaningful)
    return {
      label: "Letters or numbers",
      tone: "wait",
      searches: false,
      tip: "Add a letter or a number. Symbols on their own don’t search.",
    };
  if (chars < 2)
    return {
      label: "One more letter",
      tone: "wait",
      searches: false,
      tip: `LUME starts at two letters: names that start with them. A third looks inside names${contactsVisible ? ", emails and numbers too" : ""}.`,
    };
  if (chars === 2) return { label: "Names starting with", tone: "prefix", searches: true };
  return contactsVisible
    ? { label: "Names, emails, numbers", tone: "inside", searches: true }
    : { label: "Names only", tone: "names", searches: true };
}
