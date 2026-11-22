# Instagram

A client connects their Instagram professional account (Business or Creator). From then on every DM, comment, story
reply, story mention and ad click reaches the right lead, or waits in **Not a lead yet**, and people reply from LUME
inside Meta's rules. Plan: `docs/NEW_FEATURES_PLAN.md` §4. Build: `docs/superpowers/plans/2026-11-22-instagram-1a-channel.md`.

It is **off by default** on every LUME. It needs:

- Meta's app with the Instagram product, set up once by the owner (below);
- the relay (connect.lumecrm.in) to have the Instagram settings;
- the client's plan to include Instagram (licence `plan7`; an older plan, or none, includes it);
- an admin to switch it on in Settings → Integrations → Instagram and connect an account.

Flows (comment-to-DM automation) come in plan 1B; the screens in 1C.

## How a message travels

```
Instagram ──► Meta ──► relay /ig/in ──────────────► client's LUME /instagram/in ──► queue ──► lead / Not a lead yet
                       (Meta's signature checked;   (relay's signature checked;
                        batch split by account;      each delivery kept once)
                        routing table; nothing kept)
```

- **Instagram has one webhook address for the whole app** (no per-account address, unlike WhatsApp). So the relay
  keeps a **routing table**: Instagram account id → client LUME, in `RELAY_DATA_DIR/instagram-routes.json`. It's
  written at connect and disconnect and rebuilt from every LUME on start (`GET /instagram/accounts`), so a lost file
  heals itself. No message is ever kept at the relay.
- **Each LUME gets only its own accounts' entries**, re-signed with its own token.
- **A LUME that's down:** for its first 15 minutes Meta is asked to retry the batch (Meta retries for up to 36
  hours; the others drop repeats). After 15 minutes the relay answers Meta 200 and keeps a **gap note** (accounts and
  times, no content); the LUME catches up from Meta's Conversations API when it's back (hourly, or at once when the
  relay pings `/instagram/notes`). One client's outage never holds the others.
- **Tokens** last 60 days; each LUME refreshes its own at 30 (no app secret needed). A refused one puts the account
  in "needs attention" and tells the admins once.

## 1. The owner's one-time Meta setup

1. App Dashboard (LUME's app) → **Add product → Instagram → API setup with Instagram login**. Note the
   **Instagram app ID** and **Instagram app secret** (not the Meta app's own).
2. **Business login settings:** OAuth redirect `https://connect.lumecrm.in/ig/callback`. Deauthorize callback
   `https://connect.lumecrm.in/ig/deauthorize`; data deletion request URL `https://connect.lumecrm.in/ig/delete`.
3. **Webhooks:** callback `https://connect.lumecrm.in/ig/in`, a verify token you make up (16+ characters), fields
   `messages`, `messaging_postbacks`, `messaging_referral`, `messaging_seen`, `message_reactions`, `comments`,
   `live_comments`.
4. **Messaging type:** hybrid (automation with a person behind it).
5. **App Review** (Advanced Access): `instagram_business_basic`, `instagram_business_manage_messages`,
   `instagram_business_manage_comments`, and the **Human Agent** feature. Recordings and texts: plan §7.2. Read every
   saved field's full text before Submit. Until it's approved, only accounts with a role on the app can connect.

## 2. The relay's settings

| Setting | Value |
|---|---|
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | from step 1 |
| `INSTAGRAM_VERIFY_TOKEN` | the verify token from step 3 |
| `RELAY_DATA_DIR` | `/data`, on a named volume: `-v lume-relay-data:/data` (the image makes `/data` the `node` user's) |
| `INSTAGRAM_GRAPH_VERSION` | optional; default `v27.0` |

All three `INSTAGRAM_*` or none. The relay logs once which secret Meta signs deliveries with ("signed with the
Instagram app secret" expected); if it says Meta's, keep `META_APP_SECRET` set.

## 3. A client's server

Nothing extra in `.env`: Instagram uses the relay WhatsApp and Google use. Its Caddy must send `/instagram/in`,
`/instagram/accounts`, `/instagram/moved` and `/instagram/notes` to the API (in `infra/Caddyfile` from this release).
Optional pace settings: `LUME_IG_SEND_PER_SECOND` (default 20; Meta allows 100) and
`LUME_IG_PRIVATE_REPLIES_PER_HOUR` (default 600; Meta allows 750). The licence server must be deployed **before**
this release (it signs `instagram` in `plan7`).

## What LUME does

- **A first DM:** LUME reads the person's name and username (Meta allows it once they've written), finds the lead
  with that Instagram handle (one from ManyChat, a sheet or a form), or makes one under the account's own lead source
  (its pipeline, stage and owner rule), or, when the account says so, keeps it in Not a lead yet for 14 days.
- **Comments** are kept with their post and author; one **private reply** per comment, within 7 days.
- **Replying:** within 24 hours of the person's last message, tap or reaction (7 days after an ad click); after that,
  a person only, with Meta's human agent tag, up to 7 days; then not at all. Never to someone who didn't write.
- **Never twice:** a double tap is one message; a message whose answer Meta lost is failed with "LUME couldn't tell
  whether this went. Check Instagram before sending it again." and never resent by itself.
- **Echoes** (a reply typed in the Instagram app) land on the lead and take the conversation over.
- **Stop words** in any language make the lead do not contact at once.
- **Handles are contact details:** masked for people without "See full contact details".
- **Analytics:** Instagram sends and replies count as WhatsApp's do (first contact, reply rate, timing).
- **Meta's deauthorize** disconnects the account. **A data deletion request** also removes what Instagram sent about
  it (message words, files, comments, names); its leads stay.

## When something's wrong

| What LUME says | What to do |
|---|---|
| "Instagram stopped letting LUME in. Connect this account again." | The token was revoked or expired: Connect again. |
| "Connected to another LUME" | The account was connected on another server (a client moved). Connect it here again if this is the right one. |
| "Instagram only lets LUME connect a professional account" | Switch the account to Business or Creator in Instagram's settings. |
| No messages arriving | Relay logs for `/ig/in` and the routing table size at start; the client's API log for `/instagram/in` (401: relay token differs). |

## To verify against the test account (before the first client)

- the payload shapes (DM, echo, story reply and mention, ad referral, comment `id` vs `comment_id`);
- which secret signs Instagram Login deliveries and signed requests;
- that a private reply with quick replies is accepted, and that a tap on it opens the window;
- the Conversations API's `from.id` is the person's Instagram-scoped id;
- that the `user_id` in Meta's deauthorize and data deletion `signed_request` is the account's Instagram id (the one
  `/me` gives as `user_id`, which the relay routes by), not an app-scoped id. If it isn't, those requests are
  answered but reach no LUME: fix the relay's lookup before the first client.
