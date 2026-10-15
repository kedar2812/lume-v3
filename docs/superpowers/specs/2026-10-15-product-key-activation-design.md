# Product key activation — design

**Status:** sections 1–4 approved by the owner in chat, 2026-10-15; screens on the canvas https://claude.ai/artifact/2PhEkUtJvecyqdvFi5hyfn (awaiting approval). Builds on the licensing design
(`2026-09-30-licensing-deployment-design.md`); where the two differ, this one wins.

**Goal.** The owner hands each client one product key from the licence dashboard instead of putting it in
`.env`. A fresh LUME asks for the key first; setup continues only once the licence server approves it. A key
works on one server only.

**Project B** (a wider refinement of the licence dashboard) is a separate brainstorm and spec, after this one.

## 1. The client and their LUME

### 1.1 Setup step 1: the product key
- **When:** a release build whose `.env` has no `LUME_LICENSE_KEY`. Development builds, the demo, and installs
  keyed through `.env` keep today's step 1 (the setup token).
- **The field** ("Your product key") accepts the key with or without dashes or spaces, in any case, and shows it
  grouped as `LUME-XXXX-XXXX-XXXX-XXXX-XXXX`.
- **Continue** sends it to `POST /api/v1/setup/key`; the button reads "Checking with LUME…" meanwhile.
- **Approved:** a green tick, "Key approved — this LUME is yours", then the existing steps (business, owner,
  two-step). The answer carries the setup token to this browser only; every later step uses it exactly as today,
  so a stranger who finds a half-finished install can't take it over. The client never sees a token.
- **Refused** (LUME's voice):
  - unknown key: "LUME doesn't recognise that key. Check it against the message you were sent."
  - in use elsewhere: "This key is already active on another LUME. Ask whoever gave it to you to release it."
  - paused, or the client decommissioned: "This key's licence is paused."
  - a retired key: "This key has been decommissioned and works nowhere. Use the newest key you were sent."
  - licence server unreachable or erroring: "LUME couldn't reach the licence server. Check this server's internet
    connection, then try again."
  - too many tries: "Too many tries. Try again in an hour."
- **Re-entering** the same key on the same server (a closed tab, mid-setup) is approved again.

### 1.2 What the install keeps
In `licence_state` (one row):
- `install_id` (uuid): made once, at first boot; never changes; sent with every activation and check.
- `license_key_enc`: the key, sealed with the instance's master key (`keyring`, purpose `licence-key`).
- `instance_id`: learned from the activation answer.
- `activated_at`.
- The token, as today.

**Precedence:** `LUME_LICENSE_KEY` + `LUME_INSTANCE_ID` in `.env` win when both are set; otherwise the stored
key and instance ID are used. Checks every 6 hours run as today, with the install ID added.

### 1.3 Settings → About (owner only)
- The licence card shows the masked key (`LUME-••••-…-7Q2K`).
- **Change key**: a field and Save. The new key goes through `POST /api/v1/licence/key`, the same activation with
  this install's ID; on approval it replaces the stored key, the token refreshes and the card updates. Refusals use
  the words in §1.1.
- Hidden when the key comes from `.env` (the card says "Key set on the server").

## 2. The licence server

### 2.1 `POST /v1/activate`
- **Body (strict):** `licenseKey`, `installId` (uuid), `appVersion`, `serverTime`. Nothing about leads.
- **Lookup** by `sha256(normalised key)` against a unique index on `licences.key_hash`, compared in constant time.
- **Limits:** the wrong-key limiter used by `/v1/check`, keyed by IP; plus 30 activations an hour per IP.
- **Answers:**
  - unknown key: 401 `UNAUTHORIZED`, nothing more;
  - suspended or decommissioned: 403 `LICENCE_PAUSED`;
  - unbound: bind it (`install_id`, `activated_at`, `activated_ip`); event `activated {ip}`; then 200;
  - bound to this install: 200 (idempotent);
  - bound to another install: 409 `KEY_IN_USE`, with nothing about the other server; event
    `activation_refused {ip}`; raises the bell item in §3.4.
- **200 body:** `{ instanceId, token }`. The token is the existing signed format (`issueToken`), so the instance's
  state logic is unchanged. A check-in is recorded, as `/v1/check` does.

### 2.2 `/v1/check` changes
- The body gains `installId` (uuid, required).
- A check from a different install than the bound one gets 409 `KEY_IN_USE`; it isn't recorded as a check-in, and
  it raises `activation_refused`, at most once an hour per IP.
- A licence that has never been bound binds on its first check (installs keyed through `.env`); a released one never does (§2.4).

### 2.3 Storing keys
- New `licences.key_enc`: the key sealed with `LICENCE_MASTER_KEY` (AES-256-GCM, bound to the client id, as the
  admins' TOTP secrets are), alongside the existing `key_hash` and `key_last4`.
- Licences created before this have no `key_enc`; their card offers Rotate to get a showable key.

### 2.4 Rotate, Release and Decommission
- **Retired keys (new table `retired_keys`:** key hash, client, `retired_at`, reason `rotated | decommissioned`).
  A retired key never works again anywhere: `/v1/activate` answers 403 `KEY_DECOMMISSIONED` ("This key has been
  decommissioned and works nowhere. Use the newest key you were sent."), and a key can never be issued twice.
- **Rotate** (owner, 2026-10-15: "the old key gets decommissioned automatically"): a new key (hash, sealed, last
  four); the old key goes to `retired_keys` as `rotated`; **the binding is kept**. The client enters the new key in
  Settings → About. Until then, its check-ins with the old key are answered with the current licence (so a
  rotation never locks a client out mid-day) for 7 days, then 403 `KEY_DECOMMISSIONED`. Events `key_rotated`,
  `key_decommissioned`.
- **Decommission** (owner: a red press-and-hold button, "so that it is not misused anywhere"): held for 1.5 s on the
  Licence key card (Space or Enter held works too; letting go early springs back and does nothing). The key goes to
  `retired_keys` as `decommissioned` at once, the binding is cleared, and the licence has no live key until
  **Issue a new key**. The server that was using it is answered with a **signed `suspended` token** at its next
  check (so it pauses, with export still working); every other use answers 403 `KEY_DECOMMISSIONED`. Event
  `key_decommissioned`. Issue a new key makes a fresh key with no binding (the ready-to-send card again).
- **Release:** clears `install_id`, `activated_at`, `activated_ip` and sets `released_at`; the next server to
  activate takes it. Event `key_released`. After a release, **only `/v1/activate` (a key entered by hand) can bind
  the key**: a check-in never binds a released licence, so the old server can't quietly take it back at its next
  6-hourly check; its check-ins get 409 `KEY_IN_USE` once another server holds the key, and until then are answered
  without binding. (The bind-on-first-check rule in §2.2 applies only to a licence that has never been bound.)

## 3. The dashboard

### 3.1 New licence → "Ready to send"
After Create, the sheet shows:
- the key in large type, with **Copy key**;
- **Copy message for client**:
  > Your LUME is ready. Open https://{slug}.lumecrm.in and enter this product key when asked: {key}. It works on
  > one server only, so keep it private.
- **WhatsApp**: opens the same message (`wa.me`, with the client's number if one is stored).

### 3.2 A client's page: the Licence key card
- **Status:**
  - "Not activated yet — waiting for the client to enter it" (grey);
  - "Active on {ip} since {date}" (green);
  - "Released — the next server to enter it takes it" (amber).
- **Key:** masked, with Show, Copy and Copy message (when `key_enc` exists).
- **Actions** (inline confirm): Rotate (decommissions the old key), Release, and the existing Pause this LUME.
- **Hold to decommission key** (red, press and hold 1.5 s, §2.4); afterwards the card reads "Key decommissioned"
  with **Issue a new key**.
- **History** words: "Key created", "Activated on {ip}", "Key tried on another server ({ip})", "Key rotated",
  "Key decommissioned", "Key released".

### 3.3 Clients list
- A **"Not activated"** state (pill and filter tile): a licence nobody has entered yet.

### 3.4 The bell ("Needs a look")
- "Key tried on another server — {client}" (any `activation_refused` in the last 7 days, until hidden).
- "Issued 7+ days ago and not activated yet — {client}".

## 4. Security, changeover, testing

### 4.1 Security
- Brute force: 10 key tries an hour per IP on the instance's `/api/v1/setup/key`, plus the licence server's own
  limits; keys carry about 100 bits.
- In a release build, activation is possible only through `/setup` before any user exists, and through the
  owner's Change key. The setup token goes only to the browser that proved the key.
- Keys are never logged; the audit trail records "licence key changed" with the last four only.
- The data sent to the licence server gains only the random install ID (no lead data); the test that pins the
  check body is updated.

### 4.2 Changeover
- **Migrations:** instance `licence_state` (+ `install_id` default `gen_random_uuid()`, `license_key_enc`,
  `instance_id`, `activated_at`); licence server `licences` (+ `key_enc`, `install_id`, `activated_at`,
  `activated_ip`, `released_at`, unique `key_hash`).
- Existing licences stay valid; an `.env`-keyed server binds at its first check.
- `scripts/provision.sh`: `LUME_LICENSE_KEY` becomes optional; the closing line tells the owner to send the
  client their address and key (Copy message on the dashboard). `docs/runbooks/fleet.md` updated to match.
- Development builds and the demo are unchanged.

### 4.3 Testing
- **Licence server:** activate (new, same install, other install, unknown, paused, retired, rate limit); check with an
  install ID (bound, unbound binds, other install refused); rotate keeps the binding and retires the old key (7-day overlap); decommission (suspended token to the bound server, 403 elsewhere, Issue a new key); release; seal/unseal; the
  bell items.
- **Instance:** the key step (release vs development, `.env` precedence, each refusal, retry, rate limit, token to
  that browser only); Change key; the pinned check body.
- **E2E:** fresh install → key → setup → Today, against the existing fake licence server; axe and screenshots in
  both themes.
- **Live:** one run on the dev box against license.lumecrm.in with a throwaway licence, deleted afterwards.

### 4.4 Screens
The key step and its states, the About card, and the dashboard's Ready-to-send card, Licence key card, Not
activated state and bell items go on a canvas for the owner's approval before any UI is built. The backend
(§1.2, §2, §4.1–4.2, and the APIs behind §1.1, §1.3 and §3) does not wait for it.
