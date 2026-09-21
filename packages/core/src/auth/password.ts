import { hash, verify } from "@node-rs/argon2";

export type Argon2Params = { memoryCost: number; timeCost: number; parallelism: number };
/** Report §12.1: Argon2id, memory ≥ 64 MB, parallelism tuned for 2 vCPU. (Argon2id is the library default.) */
export const ARGON2_PRODUCTION: Argon2Params = { memoryCost: 65536, timeCost: 3, parallelism: 1 };

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256; // bounds hashing cost; no composition rules (NIST 800-63B)

export type PasswordProblem = "too_short" | "too_long" | "breached" | "contains_email";

export function passwordProblems(
  pw: string,
  ctx: { email?: string; isBreached: (pw: string) => boolean },
): PasswordProblem[] {
  if (pw.length > MAX_PASSWORD_LENGTH) return ["too_long"];
  if ([...pw].length < MIN_PASSWORD_LENGTH) return ["too_short"];
  const local = ctx.email?.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return ["contains_email"];
  if (ctx.isBreached(pw)) return ["breached"];
  return [];
}

export const hashPassword = (pw: string, params: Argon2Params): Promise<string> => hash(pw, params);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

const PARAMS_RE = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;
/** True if the stored hash isn't Argon2id with exactly these parameters; upgrade it on the next successful login. */
export function needsRehash(stored: string, params: Argon2Params): boolean {
  const m = PARAMS_RE.exec(stored);
  return (
    !m ||
    Number(m[1]) !== params.memoryCost ||
    Number(m[2]) !== params.timeCost ||
    Number(m[3]) !== params.parallelism
  );
}
