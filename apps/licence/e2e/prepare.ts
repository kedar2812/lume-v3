// Before the licence server starts for e2e: a fresh database, migrated, with the canvas's fictional clients
// (their dates moved to today), today's rates, the admin (the two-step secret written for the spec), and a
// signing key. Bundled and run by playwright.config.ts; writes e2e/.artifacts/env.json for start.mjs.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adminUrl, createTestDatabase, migrate } from "@lume/db";
import pg from "pg";
import { CANVAS_CLIENTS, CANVAS_NOW, CANVAS_RATES } from "@/lib/fixture";
import { Limiter } from "@/lib/limit";
import { addDays, utcDay } from "@/lib/state";
import { createAdmin } from "@/server/auth";
import { createClient } from "@/server/clients";
import type { Ctx } from "@/server/context";

const here = path.resolve(process.argv[2] ?? "e2e");
const out = path.join(here, ".artifacts");
mkdirSync(out, { recursive: true });

// The last run's database goes.
const envFile = path.join(out, "env.json");
if (existsSync(envFile)) {
  const old = JSON.parse(readFileSync(envFile, "utf8")) as { DB_NAME?: string };
  if (old.DB_NAME && /^t_[0-9a-f]+$/.test(old.DB_NAME)) {
    const c = new pg.Client({ connectionString: adminUrl() });
    await c.connect();
    // An identifier can't be a parameter; the name was checked against t_<hex> above.
    const drop = "DROP DATABASE IF EXISTS " + old.DB_NAME + " WITH (FORCE)";
    await c.query(drop);
    await c.end();
  }
}

const db = await createTestDatabase();
await migrate(db.url(), path.resolve(here, "../migrations"));
const pool = new pg.Pool({ connectionString: db.url(), max: 2 });
const master = randomBytes(32);
const now = new Date();
const today = utcDay(now);
const ctx = {
  db: pool,
  now: () => now,
  master,
  fetch: () => Promise.reject(new Error("no network in e2e")),
  limits: {
    ip: new Limiter(1000, 3_600_000),
    instance: new Limiter(1000, 3_600_000),
    signIn: new Limiter(1000, 900_000),
  },
} as unknown as Ctx;

const PASSWORD = "a long and lovely passphrase";
const { secret } = await createAdmin(ctx, { email: "owner@lume.test", password: PASSWORD });

await pool.query(
  "UPDATE settings SET list_price_inr = 3999, latest_version = '1.4.2', billing_contact = 'mailto:billing@lume.test'",
);
for (const [cur, rate] of Object.entries(CANVAS_RATES))
  if (cur !== "INR")
    await pool.query("INSERT INTO fx_rates (day, currency, rate_to_inr) VALUES ($1, $2, $3)", [
      today,
      cur,
      rate,
    ]);

// The canvas's clients, as they'd stand today.
const shift = now.getTime() - CANVAS_NOW.getTime();
const moved = (d: Date) => new Date(d.getTime() + shift);
const CITY: Record<string, string> = {
  "Brightpath Studio": "Pune",
  "Harbour Clinic": "Bengaluru",
  "Northwind Coaching": "Manchester",
  "Oakline Realty": "Dubai",
  "Cedar & Co Salon": "New Delhi",
  "Summit Fitness": "Mumbai",
  "Bluebell Dental": "Ahmedabad",
  "Meridian Tutors": "Austin",
  "Lotus Wellness": "Chennai",
  "Kestrel Logistics": "Singapore",
  "Saffron Events": "Mumbai",
  "Pinecrest Academy": "Hyderabad",
  "Riverstone Interiors": "Mysuru",
  "Fjord Analytics": "Berlin",
  "Coral Bay Physio": "Perth",
};
const PAID: Record<string, number> = {
  "Harbour Clinic": -3,
  "Oakline Realty": 4,
  "Lotus Wellness": 9,
  "Kestrel Logistics": 16,
  "Fjord Analytics": 12,
};
const HEARD_H: Record<string, number> = {
  "Harbour Clinic": 31,
  "Northwind Coaching": 1,
  "Coral Bay Physio": 7,
  "Kestrel Logistics": 6,
};
const OLD = new Set(["Oakline Realty", "Kestrel Logistics"]);
// Fleet (spec 2026-10-16 fleet): what each LUME on the newer version says about itself; the older two send none.
const SICK: Record<
  string,
  { diskFreePct?: number; failed24h?: number; problems?: string[]; restoreDays?: number }
> = {
  "Saffron Events": { diskFreePct: 4, failed24h: 3, problems: ["jobs_failed"] },
  "Coral Bay Physio": { problems: ["reminders_late"] },
  "Summit Fitness": { restoreDays: 9, problems: ["restore_test"] },
};
const healthAt = (name: string, i: number, hoursAgo: number) => {
  const sick = SICK[name] ?? {};
  const grow = 1 - (hoursAgo / (14 * 24)) * 0.15;
  return JSON.stringify({
    uptimeS: Math.max(60, Math.round((5 * 24 - (hoursAgo % (5 * 24))) * 3600)),
    dbBytes: Math.round((90 + i * 23) * 1_000_000 * grow),
    diskFreePct:
      sick.diskFreePct !== undefined
        ? Math.round(sick.diskFreePct + (hoursAgo / 24) * 1.4)
        : 40 + ((i * 7) % 40),
    errors24h: i % 3,
    queue: { waiting: i % 4, retrying: 0, failed24h: sick.failed24h ?? 0 },
    remindersLate: sick.problems?.includes("reminders_late") ? 2 : 0,
    restoreTest: {
      at: new Date(now.getTime() - ((sick.restoreDays ?? 1) * 24 + hoursAgo) * 3_600_000).toISOString(),
      ok: true,
    },
    problems: sick.problems ?? [],
    sourcesNeedingAttention: 0,
    // Control each client (spec 2026-10-17 §3.3): which modules are on, for the Plan limits card's warning.
    modulesOn: i % 2 ? ["googleSheets", "webhooks", "calendly"] : ["webhooks"],
  });
};
const ids: Record<string, string> = {};
// One client's LUME, bound to a known install, so the feedback test can send a report as it (spec 2026-10-16 §2.1).
let feedback: { instanceId: string; licenseKey: string; installId: string } | null = null;
for (const [i, c] of CANVAS_CLIENTS.entries()) {
  const first = c.prices[0]!;
  const made = await createClient(ctx, {
    name: c.name,
    country: c.country,
    region: c.region,
    city: CITY[c.name] ?? null,
    source: c.source,
    plan: {
      type: c.type,
      currency: first.currency,
      amount: first.amount,
      periodMonths: c.type === "perpetual" ? 0 : (first.periodMonths as 1 | 3 | 12),
    },
  });
  const id = made.client.id;
  ids[c.name] = id;
  if (i === 0) {
    const installId = "0190e0c0-0000-7000-8000-00000000fb01";
    const { rows } = await pool.query<{ instance_id: string }>(
      "UPDATE licences SET install_id = $2, activated_at = $3, activated_ip = '203.0.113.24' WHERE client_id = $1 RETURNING instance_id",
      [id, installId, now],
    );
    feedback = { instanceId: rows[0]!.instance_id, licenseKey: made.licenseKey, installId };
  }
  const created = moved(c.createdAt);
  await pool.query("UPDATE clients SET created_at = $2 WHERE id = $1", [id, created]);
  await pool.query("UPDATE events SET at = $2 WHERE client_id = $1", [id, created]);
  await pool.query("UPDATE prices SET effective_from = $2 WHERE client_id = $1", [id, created]);
  for (const p of c.prices.slice(1))
    await pool.query(
      "INSERT INTO prices (client_id, currency, amount, period_months, effective_from) VALUES ($1, $2, $3, $4, $5)",
      [id, p.currency, p.amount, p.periodMonths, moved(p.from)],
    );
  const paidUntil = c.type === "subscription" ? addDays(today, PAID[c.name] ?? 20 + i * 11) : null;
  await pool.query(
    "UPDATE licences SET created_at = $2, paying_since = $3, paid_until = $4, trial_ends = coalesce($5, trial_ends), suspended_at = $6 WHERE client_id = $1",
    [
      id,
      created,
      c.payingSince ? moved(c.payingSince) : null,
      paidUntil,
      c.trialEnds ? addDays(today, 15) : null,
      c.endedAt ? moved(c.endedAt) : null,
    ],
  );
  // Check-ins: every 6 hours for 14 days, until the last one heard.
  {
    const lastH = c.endedAt
      ? (now.getTime() - moved(c.endedAt).getTime()) / 3_600_000
      : (HEARD_H[c.name] ?? 2 + (i % 4));
    const version = OLD.has(c.name) ? "1.3.8" : "1.4.2";
    const insert = (at: Date, hoursAgo: number) =>
      pool.query(
        "INSERT INTO check_ins (client_id, at, ip, app_version, active_users, lead_count, server_time, state, health, accepts) VALUES ($1, $2, $3, $4, $5, $6, $2, 'active', $7, $8)",
        [
          id,
          at,
          `198.51.100.${10 + i}`,
          version,
          2 + (i % 6),
          120 + i * 97,
          OLD.has(c.name) ? null : healthAt(c.name, i, hoursAgo),
          OLD.has(c.name) ? null : ["announcements", "plan"],
        ],
      );
    for (let h = 14 * 24; h >= lastH; h -= 6) {
      const at = new Date(now.getTime() - h * 3_600_000);
      if (at < created) continue;
      await insert(at, h);
    }
    await insert(new Date(now.getTime() - lastH * 3_600_000), lastH);
    await pool.query(
      "INSERT INTO events (client_id, at, kind, detail) VALUES ($1, $2, 'first_check_in', $3)",
      [
        id,
        new Date(Math.max(created.getTime(), now.getTime() - 14 * 86_400_000)),
        JSON.stringify({ version, state: "active" }),
      ],
    );
  }
  // A payment or two, at their day's rate.
  if (c.type === "subscription" && !c.endedAt) {
    const rate = first.currency === "INR" ? 1 : CANVAS_RATES[first.currency as keyof typeof CANVAS_RATES];
    const amount = c.prices.at(-1)!.amount;
    await pool.query(
      "INSERT INTO payments (client_id, amount, currency, rate_to_inr, amount_inr, paid_at, paid_until, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        id,
        amount,
        first.currency,
        rate,
        Math.round(amount * rate * 100) / 100,
        new Date(now.getTime() - (5 + i) * 86_400_000),
        paidUntil,
        i % 3 === 0 ? "UPI" : "Bank transfer",
      ],
    );
  }
}
await pool.end();

const key = generateKeyPairSync("ed25519");
const keyFile = path.join(out, "signing.pem");
writeFileSync(keyFile, key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
writeFileSync(
  envFile,
  JSON.stringify({
    DB_NAME: db.name,
    DATABASE_URL: db.url(),
    LICENCE_KID: "e2e",
    // A throwaway key: not one LUME's releases trust, so the start-up key check is off for e2e.
    LICENCE_KEY_CHECK: "off",
    LICENCE_SIGNING_KEY_FILE: keyFile,
    LICENCE_MASTER_KEY: master.toString("base64"),
  }),
);
writeFileSync(
  path.join(out, "admin.json"),
  JSON.stringify({ email: "owner@lume.test", password: PASSWORD, secret, ids, feedback }),
);
console.log(`licence e2e: ${CANVAS_CLIENTS.length} clients in ${db.name}`);
