import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { tokenContext } from "./service";
import { sweepWhatsAppTokens, TOKEN_REFRESH_MS, type TokenRefresh } from "./token-refresh";

/**
 * A number's token, kept alive (2026-10-24): Meta's Embedded Signup tokens last 60 days, so LUME refreshes each one
 * through the relay once it's 30 days old, and a refusal from Meta asks for the number to be connected again.
 */
let h: Harness;
let admin: { id: string };
let numberId: string;
let asked: string[] = [];
let answer: Awaited<ReturnType<TokenRefresh>> = null;
const refresh: TokenRefresh = async (token) => {
  asked.push(token);
  return answer;
};

const row = async () =>
  (
    await h.ownerPool.query<{
      status: string;
      problem: string | null;
      token_enc: Buffer;
      token_at: Date | null;
    }>("SELECT status, problem, token_enc, token_at FROM whatsapp_numbers WHERE id = $1", [numberId])
  ).rows[0]!;
const tokenNow = async () => h.keyring.decrypt((await row()).token_enc, tokenContext(numberId));
const sweep = () =>
  sweepWhatsAppTokens(h.ownerPool, { keyring: h.keyring, clock: () => h.clock.now }, refresh);

beforeAll(async () => {
  h = await createHarness({ oauth: { relayToken: RELAY_TOKEN } });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  numberId = await seedNumber(h, { runAs: admin.id, token: "EAAG-old" });
  // Connected now, by the harness's clock.
  await h.ownerPool.query("UPDATE whatsapp_numbers SET connected_at = $2, token_at = $2 WHERE id = $1", [
    numberId,
    h.clock.now,
  ]);
  asked = [];
  answer = null;
});

describe("keeping a WhatsApp number's token alive", () => {
  it("a token under 30 days old is left alone", async () => {
    h.clock.advance(TOKEN_REFRESH_MS - 3_600_000);
    await sweep();
    expect(asked).toEqual([]);
  });

  it("at 30 days it's refreshed, kept encrypted, and its age starts again", async () => {
    h.clock.advance(TOKEN_REFRESH_MS + 1);
    answer = { token: "EAAG-new" };
    await sweep();
    expect(asked).toEqual(["EAAG-old"]);
    expect(await tokenNow()).toBe("EAAG-new");
    expect((await row()).token_at?.getTime()).toBe(h.clock.now.getTime());
    expect((await row()).status).toBe("active");
    asked = [];
    await sweep();
    expect(asked).toEqual([]);
  });

  it("a number connected before LUME kept the token's age counts from when it was connected", async () => {
    await h.ownerPool.query("UPDATE whatsapp_numbers SET token_at = NULL WHERE id = $1", [numberId]);
    h.clock.advance(TOKEN_REFRESH_MS + 1);
    answer = { token: "EAAG-new" };
    await sweep();
    expect(await tokenNow()).toBe("EAAG-new");
  });

  it("the relay or Meta can't be reached: the token stays, and it's tried again next time", async () => {
    h.clock.advance(TOKEN_REFRESH_MS + 1);
    answer = null;
    await sweep();
    expect(await tokenNow()).toBe("EAAG-old");
    expect((await row()).status).toBe("active");
    await sweep();
    expect(asked).toEqual(["EAAG-old", "EAAG-old"]);
  });

  it("Meta refuses the token: the number asks to be connected again, in words", async () => {
    h.clock.advance(TOKEN_REFRESH_MS + 1);
    answer = "revoked";
    await sweep();
    expect(await row()).toMatchObject({
      status: "needs_attention",
      problem: "WhatsApp stopped letting LUME in. Connect this number again.",
    });
  });

  it("a number connected again while its old token was being refreshed keeps the new connection's token", async () => {
    h.clock.advance(TOKEN_REFRESH_MS + 1);
    const reconnect: TokenRefresh = async () => {
      await h.ownerPool.query("UPDATE whatsapp_numbers SET token_enc = $2 WHERE id = $1", [
        numberId,
        h.keyring.encrypt("EAAG-reconnected", tokenContext(numberId)),
      ]);
      return { token: "EAAG-refreshed-old" };
    };
    await sweepWhatsAppTokens(h.ownerPool, { keyring: h.keyring, clock: () => h.clock.now }, reconnect);
    expect(await tokenNow()).toBe("EAAG-reconnected");
  });

  it("disconnected numbers and numbers needing attention aren't asked about", async () => {
    h.clock.advance(TOKEN_REFRESH_MS + 1);
    await h.ownerPool.query("UPDATE whatsapp_numbers SET status = 'needs_attention' WHERE id = $1", [
      numberId,
    ]);
    await sweep();
    await h.ownerPool.query(
      "UPDATE whatsapp_numbers SET status = 'disconnected', token_enc = NULL WHERE id = $1",
      [numberId],
    );
    await sweep();
    expect(asked).toEqual([]);
  });
});
