/** Titles people put before their name, in India and abroad: never a first name to greet someone by. */
const TITLES = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "mx",
  "dr",
  "prof",
  "sir",
  "madam",
  "shri",
  "sri",
  "shree",
  "smt",
  "kumari",
  "km",
  "er",
  "adv",
]);
const isTitle = (w: string) => TITLES.has(w.toLowerCase().replace(/\.$/, ""));
const hasLetter = (w: string) => /\p{L}/u.test(w);

/**
 * The first name a message greets someone by: the first word with a letter in it, past any title ("Dr. Ananya
 * Rao" → "Ananya"). A title with only a surname stays whole ("Mr Rao"), and a name with no letters (a phone
 * number) gives "" — so a template says the value is missing instead of greeting "Hi +971,".
 */
export function firstNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(hasLetter);
  if (words.length === 0) return "";
  if (!isTitle(words[0]!)) return words[0]!;
  const rest = words.slice(1);
  if (rest.length === 0) return words[0]!;
  return rest.length === 1 ? `${words[0]} ${rest[0]}` : rest[0]!;
}
