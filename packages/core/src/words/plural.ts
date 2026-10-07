/**
 * A count and its noun, in agreement: "1 lead", "0 leads", "12,345 rows", "5 people". Numbers are grouped the
 * way LUME groups them elsewhere (en-US). For nouns that don't just take an s, pass the plural.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
