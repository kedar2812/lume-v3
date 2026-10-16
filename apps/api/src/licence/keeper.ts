import type pg from "pg";
import {
  ACCEPTS,
  activateBody,
  canonicalKey,
  checkBody,
  feedbackBody,
  licenceState,
  verifyLicence,
  type FeedbackReport,
  type FleetHealth,
  type Keyring,
  type LicencePayload,
  type LicenceView,
} from "@lume/core";
import { asksForKey, type LicenceOptions } from "./options";

const REFRESH_MS = 30_000;
const CHECK_TIMEOUT_MS = 10_000;
/** Why an activation didn't go through (spec 2026-10-15 §1.1): the words for each live in the web. */
export type ActivateRefusal =
  "format" | "not_recognised" | "in_use" | "decommissioned" | "paused" | "too_many" | "unreachable";
export type ActivateOutcome = { ok: true; view: LicenceView } | { ok: false; reason: ActivateRefusal };
/** What became of a report (spec 2026-10-16 §4.1): the words for each live in the web. */
export type FeedbackOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: "no_key" | "unreachable" | "limited" | "licence" | "image";
      retryAfterS?: number;
      index?: number;
    };
/** What the sealed key is bound to in the keyring. */
const KEY_CONTEXT = "licence-key";
/** Every 6 hours (spec §3.2). */
export const CHECK_EVERY_MS = 6 * 3_600_000;
/** A sign-in checks again if the last try is older than this (so a payment reminder shows at the next one). */
export const STALE_AT_SIGN_IN_MS = 15 * 60_000;

type Row = {
  token: string | null;
  first_boot_at: Date;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  install_id: string;
  instance_id: string | null;
  license_key_enc: Buffer | null;
};

/**
 * What this instance knows of its licence, and the one place that asks the licence server (licensing L-A).
 * The state is kept in memory for the API's hooks and refreshed from the database at most every 30
 * seconds; a check writes the result and refreshes at once. It never throws: a failed check is recorded
 * and the last good token stands.
 */
export class LicenceKeeper {
  private row: Row | null = null;
  private payload: LicencePayload | null = null;
  private loadedAt = 0;
  private inFlight: Promise<LicenceView> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Reads this LUME's health for the check-in (spec 2026-10-16 fleet §1.1); set by the app once it's built. */
  private health: (() => Promise<FleetHealth | null>) | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: LicenceOptions,
    private readonly now: () => Date,
    private readonly log: (o: object, msg: string) => void = () => undefined,
    /** Seals the product key the owner gave (spec 2026-10-15 §1.2); without it only an .env key can be used. */
    private readonly keyring: Keyring | null = null,
  ) {}

  /** The key in .env wins (the owner's own servers); otherwise the one entered at setup or in Settings → About. */
  private creds(): { instanceId: string; licenseKey: string } | null {
    if (this.opts.instanceId && this.opts.licenseKey)
      return { instanceId: this.opts.instanceId, licenseKey: this.opts.licenseKey };
    const r = this.row;
    if (!r?.instance_id || !r.license_key_enc || !this.keyring) return null;
    try {
      return { instanceId: r.instance_id, licenseKey: this.keyring.decrypt(r.license_key_enc, KEY_CONTEXT) };
    } catch {
      return null;
    }
  }

  /** Where this install's key comes from: its .env, the database, or nowhere yet. */
  keySource(): "env" | "stored" | null {
    if (this.opts.instanceId && this.opts.licenseKey) return "env";
    return this.creds() ? "stored" : null;
  }

  /** The key's last four, for Settings → About. */
  keyLast4(): string | null {
    return this.creds()?.licenseKey.slice(-4) ?? null;
  }

  /** A key is asked for at setup (spec 2026-10-15 §1.1): an enforced licence with none in .env. */
  needsKey(): boolean {
    return asksForKey(this.opts);
  }

  get dev(): boolean {
    return this.opts.mode === "dev";
  }

  /** This installation's id, and when LUME will ask next (Settings → About). */
  info(): { instanceId: string | null; nextCheckAt: string | null } {
    const last = this.row?.last_attempt_at;
    return {
      instanceId: this.creds()?.instanceId ?? this.opts.instanceId,
      nextCheckAt: !this.dev && last ? new Date(last.getTime() + CHECK_EVERY_MS).toISOString() : null,
    };
  }

  /** Why the last check didn't bring a new answer (for people who manage settings), or null. */
  lastError(): string | null {
    return this.dev ? null : (this.row?.last_error ?? null);
  }

  /** The state now (from memory; a stale copy is refreshed in the background). */
  view(): LicenceView {
    if (!this.dev && Date.now() - this.loadedAt > REFRESH_MS) void this.refresh().catch(() => undefined);
    return this.compute();
  }

  private compute(): LicenceView {
    return licenceState({
      payload: this.payload,
      lastSuccessAt: this.row?.last_success_at ?? null,
      firstBootAt: this.row?.first_boot_at ?? this.now(),
      now: this.now(),
      dev: this.dev,
    });
  }

  /** Read what the database holds, and act on it from now on. */
  async refresh(): Promise<LicenceView> {
    const { rows } = await this.pool.query<Row>(
      `SELECT token, first_boot_at, last_attempt_at, last_success_at, last_error, install_id, instance_id,
              license_key_enc
         FROM licence_state WHERE id = 1`,
    );
    this.row = rows[0] ?? null;
    const instanceId = this.creds()?.instanceId ?? null;
    this.payload =
      this.row?.token && instanceId ? verifyLicence(this.row.token, this.opts.keys, instanceId) : null;
    this.loadedAt = Date.now();
    return this.compute();
  }

  /** Ask the licence server now (one at a time: a second call joins the first). */
  check(): Promise<LicenceView> {
    if (this.dev) return Promise.resolve(this.compute());
    this.inFlight ??= this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** At a sign-in: check in the background if the last try is stale (spec §3.2); never waits, never throws. */
  checkIfStale(maxAgeMs = STALE_AT_SIGN_IN_MS): void {
    if (this.dev) return;
    const last = this.row?.last_attempt_at?.getTime() ?? 0;
    if (this.now().getTime() - last < maxAgeMs) return;
    void this.check().catch(() => undefined);
  }

  /** Tests: resolves once no check is running. */
  async idle(): Promise<void> {
    while (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  /** How this LUME reads its own health for each check-in (app.ts). */
  reportHealth(read: () => Promise<FleetHealth | null>): void {
    this.health = read;
  }

  /** How many people pressed Got it on each announcement LUME is showing (fleet §1.2): counts, never who. */
  private async seen(): Promise<{ id: string; people: number }[] | undefined> {
    const ids = (this.payload?.announcements ?? []).map((a) => a.id);
    if (!ids.length) return undefined;
    const { rows } = await this.pool.query<{ id: string; n: number }>(
      "SELECT announcement_id::text AS id, count(*)::int AS n FROM announcement_got_it WHERE announcement_id = ANY($1::uuid[]) GROUP BY announcement_id",
      [ids],
    );
    return ids.map((id) => ({ id, people: rows.find((r) => r.id === id)?.n ?? 0 }));
  }

  /** At start and every 6 hours (main.ts). */
  start(): void {
    if (this.dev) return;
    void this.check().catch(() => undefined);
    this.timer = setInterval(() => void this.check().catch(() => undefined), CHECK_EVERY_MS);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async runCheck(): Promise<LicenceView> {
    const at = this.now();
    let error: string | null = null;
    let token: string | null = null;
    const creds = this.creds();
    if (!creds || !this.row) {
      error = "This install has no licence key yet";
    } else {
      try {
        const counts = await this.counts();
        // Health and Got it counts never hold a check-in up: unreadable, it goes without them.
        const health = this.health ? await this.health().catch(() => null) : null;
        const seen = await this.seen().catch(() => undefined);
        const base = {
          instanceId: creds.instanceId,
          licenseKey: creds.licenseKey,
          installId: this.row.install_id,
          appVersion: this.opts.version,
          ...counts,
          now: at,
        };
        const post = (body: object) =>
          (this.opts.fetch ?? fetch)(`${this.opts.url}/v1/check`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
          });
        let r = await post(checkBody({ ...base, accepts: ACCEPTS, health, ...(seen ? { seen } : {}) }));
        // A licence server from before Fleet refuses a body it doesn't know (400): ask again the old way, once, so a
        // LUME newer than its licence server never loses its licence over it (spec 2026-10-16 fleet §1.3).
        if (r.status === 400) {
          await r.body?.cancel().catch(() => undefined);
          r = await post(checkBody(base));
        }
        const code = r.ok ? null : await errorCode(r);
        if (r.status === 401) error = "The licence server didn't recognise this install's key";
        else if (code === "KEY_IN_USE") error = "This key is in use on another server";
        else if (code === "KEY_DECOMMISSIONED") error = "This key has been decommissioned";
        else if (!r.ok) error = `The licence server answered ${r.status}`;
        else {
          const got = ((await r.json()) as { token?: unknown }).token;
          const p = typeof got === "string" ? verifyLicence(got, this.opts.keys, creds.instanceId) : null;
          if (!p) error = "The licence server's answer was not signed by LUME for this install";
          // An answer older than the one kept is an old answer replayed: it never undoes a newer one.
          else if (this.payload && Date.parse(p.issuedAt) < Date.parse(this.payload.issuedAt))
            error = "The licence server's answer was older than the one LUME already has, so it was ignored";
          else token = got as string;
        }
      } catch (e) {
        error = `LUME couldn't reach its licence server (${(e as Error).message})`;
      }
    }
    if (token)
      await this.pool.query(
        "UPDATE licence_state SET token = $1, last_attempt_at = $2, last_success_at = $2, last_error = NULL, updated_at = $2 WHERE id = 1",
        [token, at],
      );
    else
      await this.pool.query(
        "UPDATE licence_state SET last_attempt_at = $1, last_error = $2, updated_at = $1 WHERE id = 1",
        [at, error],
      );
    if (error) this.log({ error }, "licence check failed");
    return this.refresh();
  }

  /**
   * Activate a product key (spec 2026-10-15 §1.1, §2.1): the licence server binds it to this install and answers
   * the instance id and a signed licence. Only an answer LUME can verify is kept; on any refusal nothing changes.
   * Never throws.
   */
  async activate(typed: string): Promise<ActivateOutcome> {
    const key = canonicalKey(typed);
    if (!key) return { ok: false, reason: "format" };
    if (!this.keyring) return { ok: false, reason: "unreachable" };
    if (!this.row) await this.refresh();
    const installId = this.row!.install_id;
    const at = this.now();
    let r: Response;
    try {
      r = await (this.opts.fetch ?? fetch)(`${this.opts.url}/v1/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          activateBody({ licenseKey: key, installId, appVersion: this.opts.version, now: at }),
        ),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (e) {
      this.log({ error: (e as Error).message }, "licence activation unreachable");
      return { ok: false, reason: "unreachable" };
    }
    if (!r.ok) return { ok: false, reason: refusalOf(r.status, await errorCode(r)) };
    let instanceId: unknown;
    let token: unknown;
    try {
      ({ instanceId, token } = (await r.json()) as { instanceId?: unknown; token?: unknown });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (
      typeof instanceId !== "string" ||
      typeof token !== "string" ||
      !verifyLicence(token, this.opts.keys, instanceId)
    )
      return { ok: false, reason: "unreachable" };
    await this.pool.query(
      `UPDATE licence_state SET license_key_enc = $1, instance_id = $2, activated_at = $3, token = $4,
              last_attempt_at = $3, last_success_at = $3, last_error = NULL, updated_at = $3
        WHERE id = 1`,
      [this.keyring.encrypt(key, KEY_CONTEXT), instanceId, at, token],
    );
    const view = await this.refresh();
    // The first check-in, with this install's counts, follows at once (the activation sent none).
    void this.check().catch(() => undefined);
    return { ok: true, view };
  }

  /** A report can go: an enforced licence that holds a key (the demo and development have none to send under). */
  canSendFeedback(): boolean {
    return !this.dev && !!this.creds();
  }

  /**
   * Forward one report to the licence server (spec 2026-10-16 §1.4) under this install's credentials, as a check-in
   * goes. Nothing is kept here. Never throws.
   */
  async sendFeedback(o: {
    browser: string;
    reporter: { name: string; email: string; role: string };
    report: FeedbackReport;
  }): Promise<FeedbackOutcome> {
    if (!this.row) await this.refresh().catch(() => undefined);
    const creds = this.creds();
    if (this.dev || !creds || !this.row) return { ok: false, reason: "no_key" };
    let r: Response;
    try {
      r = await (this.opts.fetch ?? fetch)(`${this.opts.url}/v1/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          feedbackBody({
            instanceId: creds.instanceId,
            licenseKey: creds.licenseKey,
            installId: this.row.install_id,
            appVersion: this.opts.version,
            browser: o.browser,
            reporter: o.reporter,
            report: o.report,
          }),
        ),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (e) {
      this.log({ error: (e as Error).message }, "feedback: the licence server is unreachable");
      return { ok: false, reason: "unreachable" };
    }
    if (r.status === 201) return { ok: true };
    if (r.status === 429)
      return {
        ok: false,
        reason: "limited",
        retryAfterS: Math.max(1, Number(r.headers.get("retry-after")) || 3600),
      };
    if (r.status === 422) {
      let index: number | undefined;
      try {
        const i = ((await r.json()) as { error?: { index?: unknown } }).error?.index;
        if (typeof i === "number" && Number.isInteger(i)) index = i;
      } catch {
        // Which screenshot is a nicety; the refusal stands without it.
      }
      return { ok: false, reason: "image", ...(index === undefined ? {} : { index }) };
    }
    if (r.status === 401 || r.status === 403 || r.status === 409) return { ok: false, reason: "licence" };
    return { ok: false, reason: "unreachable" };
  }

  /** The two numbers the check sends (spec §2.4): members (a paused person included, 6A R7), and leads — counts only. */
  private async counts(): Promise<{ activeUserCount: number; leadCount: number }> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      // LUME's own count, naming nobody: every lead.
      await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
      const { rows } = await c.query<{ users: number; leads: number }>(
        `SELECT (SELECT count(*)::int FROM users WHERE status IN ('active', 'suspended')) AS users,
                (SELECT count(*)::int FROM leads WHERE deleted_at IS NULL) AS leads`,
      );
      await c.query("COMMIT");
      return { activeUserCount: rows[0]?.users ?? 0, leadCount: rows[0]?.leads ?? 0 };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

/** A refusal's code from the licence server's answer, if it says one. */
async function errorCode(r: Response): Promise<string | null> {
  try {
    const body = (await r.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

/** What an activation's refusal means for the person entering the key. */
function refusalOf(status: number, code: string | null): ActivateRefusal {
  if (status === 401) return "not_recognised";
  if (status === 409) return "in_use";
  if (status === 429) return "too_many";
  if (code === "KEY_DECOMMISSIONED") return "decommissioned";
  if (code === "LICENCE_PAUSED") return "paused";
  return "unreachable";
}
