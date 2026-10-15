# Product key activation — what shipped (2026-10-15)

Spec: `docs/superpowers/specs/2026-10-15-product-key-activation-design.md` · Plan:
`docs/superpowers/plans/2026-10-15-product-key-activation.md` · Canvas: approved 2026-10-15.

## What a client sees

1. Their LUME opens on **Your product key** (step 1 of 4). Dashes, spaces, lower case, `O` for `0`, `I`/`L` for `1`
   and a missing `LUME-` don't matter.
2. A wrong key, a key already active on another server, too many tries or the licence server out of reach each get
   their own words. Nothing is stored until the key is approved.
3. Approved: **Congratulations — your LUME is online** (the mark rises and turns, a green ring draws, the online
   chime), then Proceed to onboarding and the usual setup.
4. Settings → About shows the key's last four. The owner can **Change key**: the new key is checked first and
   replaces the old one only once approved. A key set in `.env` says so and can't be changed there.
5. An install that asks for a key never prints a setup token, and the token opens nothing until a key is
   approved. A key entered weeks after the server first started still activates.
6. A paused or read-only LUME takes a new key from its owner: **Enter a new product key** on the lock screen, or
   from the read-only bar to Settings → About. Approved, LUME carries on at once.

## What the owner sees on license.lumecrm.in

- **New licence** ends on **Ready to send**: the key, the message for the client, Copy message, Send on WhatsApp.
- Each client's **Licence key** card: Not activated yet / Active on {address} / Released / Decommissioned; Show and
  Copy; Copy message for client; **Rotate key** (a new key on the same server; the old one is decommissioned, and
  its own server keeps working on it for 7 days); **Release key** (the next server to enter it takes it);
  **Hold to decommission key** (1.5 s; the key works nowhere, and the LUME using it pauses at its next check-in;
  export still works); then **Issue a new key**.
- Clients list: a **Not activated** pill and tile. The bell: **Key tried on another server**, and a licence still
  not activated after 7 days (with Copy message).
- History: activated, released, rotated, "Old key decommissioned by the rotate", decommissioned, tried elsewhere.

## Deployed

- Licence server: `lume-licence:0.2.1` on the owner's host (0.2.0 on 2026-10-15 with migration 0004, then 0.2.1
  with the review fixes), each after a `pg_dump` (`/root/lume-licence/backups/`). The image before product keys is
  kept as `lume-licence:pre-0004` for rollback. `/healthz` 200 locally and at license.lumecrm.in.
- It still answers installations from before product keys (no install ID) while no installation holds their key, so
  the fleet can follow at its own pace.
- Installations get the change with the next LUME release (migration 0065). `provision.sh` no longer needs a key.

## How it was checked

- Unit: 3210 passed, 1 flaky (below; 3 of 3 on rerun) · licence app 188 · web e2e 198 (three skip themselves late in the Dubai
  evening) · licence e2e 4 · no screenshot baseline changed · CI green.
- A fresh whole-change review found two Criticals (a paused or read-only LUME couldn't take a new key; a key
  entered 7+ days after the first start was refused) and two Importants (old installs against the new licence
  server; Rotate then Decommission didn't pause the old server). All four were fixed test-first.
- Live walk on a throwaway install against a throwaway licence server running the deployed image: key step in
  light, dark and on a phone; wrong key; the token path closed (403 KEY_FIRST); the key in use elsewhere; tried on
  another server → Release; the online moment (frames at 0.3, 1.0, 1.8, 2.6, 4.0 s); setup to Welcome; Active on
  the install's server; Rotate → Change key in About (light and dark); hold to decommission → the install pauses;
  Issue a new key → entered on the lock screen → LUME carries on. 17 of 17 steps. Both throwaways were torn down.
- The production dashboard itself was not signed into (the session declined to use the admin's credentials); its
  screens are the same code the throwaway ran.

## Rulings made while building

Each is in the executor's ledger with its cost if wrong; the owner report lists them all. The ones that changed
behaviour: `/v1/activate` records no check-in (the first check follows at once); in key mode the business step has
no Back; `provision.sh` never prints a setup token for a key-mode install; Rotate's retired key reads "Old key
decommissioned by the rotate" in the history; the panel's solid red is `#ce2c31` (contrast); a key-mode install
never prints or accepts a setup token before its key; setup and Change key pass the licence lock.

## Deferred (minor)

- The wrong-key limit on `/v1/activate` is per address, so junk keys sent through a fresh install's setup could hold
  its real key off for an hour; key it by address and install.
- The ".env wins" keeper test stores an unreadable blob; seal a real key in it.
- `/v1/activate` records "tried on another server" on every refusal, without the hourly de-duplication checks use.
- Rotate's words and runbook §8a say "enter the new key in Settings → About"; a server keyed through `.env` needs
  `.env` edited and a restart.
- An install isn't told its key was rotated; it learns from the owner's message, or after 7 days.
- Showing a key on the dashboard writes no history line.
- Change key to another licence's key leaves the old licence showing "Active on …".
- The setup key limit counts tries before the answer, so retries while the licence server is down use it up.
- A key with extra characters past the twenty still activates (pinned on purpose, harmless).
- Not this change: the "LUME is paused" screen dims the page but not the sidebar.
- A pre-existing flaky test: tasks "says when the day is clear" mixes the real clock with the test clock.
