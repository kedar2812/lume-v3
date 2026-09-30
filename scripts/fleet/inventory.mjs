#!/usr/bin/env node
// LUME's client inventory, deploy/clients.yml (licensing L-C): who runs LUME, where, on which version.
// No secrets live here (each client's are in deploy/clients/<slug>.env, gitignored).
//   node inventory.mjs list                      the clients that aren't decommissioned, one slug a line
//   node inventory.mjs get <slug> <field>        one field
//   node inventory.mjs set <slug> <field> <value>
// It reads and writes only this file's own fixed shape (a list of flat entries), and refuses anything else
// rather than guess. LUME_INVENTORY points it at another file (tests).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = process.env.LUME_INVENTORY ?? path.resolve(import.meta.dirname, "../../deploy/clients.yml");
const FIELDS = {
  slug: /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/,
  host: /^[A-Za-z0-9.:-]{1,253}$/,
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  version: /^(\d+\.\d+\.\d+|none)$/,
  licence: /^(subscription|perpetual|trial)$/,
  instance: /^LUME-[0-9A-Z]{4}-[0-9A-Z]{4}$/,
  status: /^(new|active|decommissioned)$/,
};
const fail = (msg) => {
  console.error(`clients.yml: ${msg}`);
  process.exit(2);
};

/** The file as lines, and where each client's fields are. */
function load() {
  const lines = readFileSync(FILE, "utf8").split("\n");
  const clients = [];
  let inList = false;
  lines.forEach((line, i) => {
    if (/^\s*(#.*)?$/.test(line)) return;
    if (/^clients:\s*(\[\])?\s*$/.test(line)) return void (inList = true);
    const m = /^( {2}- | {4})([a-z]+): (.*?)\s*$/.exec(line);
    if (!inList || !m) fail(`line ${i + 1} isn't part of the clients list: "${line}"`);
    const [, lead, key, value] = m;
    if (lead === "  - ") clients.push({ at: {}, values: {} });
    const c = clients.at(-1);
    if (!c) fail(`line ${i + 1}: a field before any client`);
    if (!Object.hasOwn(FIELDS, key)) fail(`line ${i + 1}: unknown field "${key}"`);
    if (!FIELDS[key].test(value)) fail(`line ${i + 1}: "${value}" isn't a valid ${key}`);
    c.at[key] = i;
    c.values[key] = value;
  });
  const seen = new Set();
  for (const c of clients) {
    if (!c.values.slug) fail("a client without a slug");
    if (!c.values.host) fail(`client "${c.values.slug}" has no host`);
    if (seen.has(c.values.slug)) fail(`client "${c.values.slug}" is listed twice`);
    seen.add(c.values.slug);
  }
  return { lines, clients };
}
const find = (clients, slug) => clients.find((c) => c.values.slug === slug) ?? fail(`no client "${slug}"`);

const [cmd, slug, field, value] = process.argv.slice(2);
const { lines, clients } = load();
if (cmd === "list") {
  const live = clients.filter((c) => c.values.status !== "decommissioned").map((c) => c.values.slug);
  if (live.length) console.log(live.join("\n"));
} else if (cmd === "get") {
  if (!Object.hasOwn(FIELDS, field ?? "")) fail(`unknown field "${field}"`);
  console.log(find(clients, slug).values[field] ?? "");
} else if (cmd === "set") {
  if (!Object.hasOwn(FIELDS, field ?? "") || field === "slug") fail(`unknown field "${field}"`);
  if (!FIELDS[field].test(value ?? "")) fail(`"${value}" isn't a valid ${field}`);
  const c = find(clients, slug);
  if (c.at[field] !== undefined) lines[c.at[field]] = `    ${field}: ${value}`;
  else lines.splice(Math.max(...Object.values(c.at)) + 1, 0, `    ${field}: ${value}`);
  writeFileSync(FILE, lines.join("\n"));
} else fail("usage: inventory.mjs list | get <slug> <field> | set <slug> <field> <value>");
