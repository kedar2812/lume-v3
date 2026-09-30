import type pg from "pg";
import { checkBody, licenceState, verifyLicence, type LicencePayload, type LicenceView } from "@lume/core";
import type { LicenceOptions } from "./options";

const REFRESH_MS = 30_000;
const CHECK_TIMEOUT_MS = 10_000;
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

  constructor(
    private readonly pool: pg.Pool,
    private readonly opts: LicenceOptions,
    private readonly now: () => Date,
    private readonly log: (o: object, msg: string) => void = () => undefined,
  ) {}

  get dev(): boolean {
    return this.opts.mode === "dev";
  }

  /** This installation's id, and when LUME will ask next (Settings → About). */
  info(): { instanceId: string | null; nextCheckAt: string | null } {
    const last = this.row?.last_attempt_at;
    return {
      instanceId: this.opts.instanceId,
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
      "SELECT token, first_boot_at, last_attempt_at, last_success_at, last_error FROM licence_state WHERE id = 1",
    );
    this.row = rows[0] ?? null;
    this.payload =
      this.row?.token && this.opts.instanceId
        ? verifyLicence(this.row.token, this.opts.keys, this.opts.instanceId)
        : null;
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
    if (!this.opts.instanceId || !this.opts.licenseKey) {
      error = "This install has no licence key yet (LUME_LICENSE_KEY and LUME_INSTANCE_ID)";
    } else {
      try {
        const counts = await this.counts();
        const r = await (this.opts.fetch ?? fetch)(`${this.opts.url}/v1/check`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            checkBody({
              instanceId: this.opts.instanceId,
              licenseKey: this.opts.licenseKey,
              appVersion: this.opts.version,
              ...counts,
              now: at,
            }),
          ),
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        if (r.status === 401) error = "The licence server didn't recognise this install's key";
        else if (!r.ok) error = `The licence server answered ${r.status}`;
        else {
          const got = ((await r.json()) as { token?: unknown }).token;
          const p = typeof got === "string" ? verifyLicence(got, this.opts.keys, this.opts.instanceId) : null;
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

  /** The two numbers the check sends (spec §2.4): people who can sign in, and leads — counts only. */
  private async counts(): Promise<{ activeUserCount: number; leadCount: number }> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      // LUME's own count, naming nobody: every lead.
      await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
      const { rows } = await c.query<{ users: number; leads: number }>(
        `SELECT (SELECT count(*)::int FROM users WHERE status = 'active') AS users,
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
