const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The template values a message still names but couldn't fill ("lead.custom.budget"), each once, as typed now. */
export const missingIn = (text: string): string[] => [
  ...new Set([...text.matchAll(TOKEN)].map((m) => m[1]!)),
];
