# WhatsApp

A client connects the WhatsApp Business app number they already use (Meta's coexistence: the app keeps working on the
phone). From then on, every reply a lead sends, and every message sent from that phone, lands on the lead in LUME by
itself. Messages from numbers no lead has wait in **Not a lead yet** for 14 days. Spec:
`docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §3–4.

It is **off by default** on every LUME. It needs:

- Meta's app, set up once by the owner (below);
- the connect relay (connect.lumecrm.in) to have Meta's settings;
- the client's plan to include WhatsApp;
- an admin to switch it on in Settings → Integrations → WhatsApp and connect a number.

## How a message travels

```
Lead's phone ──► Meta ──► relay /wa/in/<instance> ──► client's LUME /whatsapp/in ──► the lead
                 (signed with Meta's    (checks Meta's signature,      (checks the relay's signature, keeps each
                  app secret)            stores nothing, signs with     message once, then a queue puts it on the
                                         the instance's token)          lead, or in Not a lead yet)
```

- **Meta's app secret** lives only on the relay.
- **Each client's business token** lives only on that client's server, encrypted. LUME uses it to fetch photos,
  voice notes and files, at most 25 MB each.
- **The relay keeps no list of numbers.** At connect, it subscribes the client's WhatsApp account with its own address
  at the relay (`/wa/in/<instance>`). Message text passes through it in memory only.
- **If the client's server is down,** the relay tells Meta to try again later.

## 1. The owner's one-time Meta setup

1. **developers.facebook.com:** create an app (type Business) named LUME, and add the **WhatsApp** product. Meta gives
   a **test number** at once: it can message up to 5 phones you verify. Use it to check everything below before any
   client connects.
2. **App settings → Basic:** note the **App ID** and **App Secret**.
3. **WhatsApp → Embedded Signup → Configurations:** create a configuration for **existing WhatsApp Business app
   numbers** (coexistence), with the permissions `whatsapp_business_management` and `whatsapp_business_messaging`.
   Note its **Configuration ID**.
4. **Facebook Login for Business → Settings:** add `https://connect.lumecrm.in` to **Allowed domains**, and as a
   **Valid OAuth redirect URI**.
5. **Webhooks:** you don't set one app-wide. Each client's account gets its own address at connect. Make up a
   **verify token** (16+ random characters) for the relay's settings below.
6. **Before real clients:** business verification (Udyam registration in LUME's name), then app review for the two
   permissions (LUME becomes a Tech Provider). Until then only your own test number and accounts can connect.

## 2. The relay's settings (connect.lumecrm.in)

Add these to the relay's environment and redeploy it:

| Setting | Value |
|---|---|
| `META_APP_ID` | the App ID |
| `META_APP_SECRET` | the App Secret |
| `META_CONFIG_ID` | the Embedded Signup configuration ID |
| `META_VERIFY_TOKEN` | the verify token you made up |
| `META_GRAPH_VERSION` | optional; default `v23.0` |

Set all four of the first settings, or none. Without them the relay is Google's only, and LUME says "WhatsApp comes
through LUME's relay, which isn't set up on this server yet."

## 3. A client's server

Nothing extra: WhatsApp uses the same relay connection as Connect with Google (`GOOGLE_OAUTH_RELAY_URL` and
`GOOGLE_OAUTH_RELAY_TOKEN` in the client's inputs). Its Caddy sends `/whatsapp/in` to the API; that's in
`infra/Caddyfile` from this release on.

## 4. Connecting a number (the client's admin)

1. Settings → Integrations → **WhatsApp**: switch it on.
2. **Connect a WhatsApp number.** LUME says first what changes on the phone:
   - broadcast lists stop working;
   - the WhatsApp app for Windows stops working (use WhatsApp Web);
   - the phone must open WhatsApp at least every 13 days.
3. **Continue with Facebook:** log in, choose the WhatsApp Business app number, scan the code with that phone, and
   choose whether to share past chats.
4. Back in LUME: choose **whose number** it is, a person or the business. A person's number sends its replies'
   notices to the lead's owner; strangers who write to it wait in that person's Not a lead yet.

## Files: where they're kept, how long, and their backup (2026-10-19)

- **Where they live.** Photos, voice notes, videos and documents (25 MB at most) are kept on the client's server,
  in the `files` volume, each once and named by its content's SHA-256. A brochure sent to 150 leads is one file. The
  database holds only which message points at which file.
- **How long they're kept.** Forever by default. An admin can choose 2 years, 1 year, 6 months or 3 months (Settings →
  Integrations → WhatsApp → Keep WhatsApp files). LUME asks first and says how many files would go. Older files leave
  within the hour; the messages stay on their leads, saying the file is still on the phone. A removed file doesn't
  come back: Meta's links expire, so LUME can't fetch it again.
- **Disk guards.**
  - System health shows the disk, the database and WhatsApp's files. Admins are told once a business day, in the app
    and by email, when the disk is 85% full.
  - At 95%, LUME stops keeping new files: they wait with "The server's disk is full" and are tried again every
    15 minutes. The database never runs out of room first.
  - Files from numbers no lead has are capped at 1 GB a day for each connected number.
- **Backup.** After each 6-hourly dump, the worker sends off-site every file the remote doesn't have yet, encrypted to
  the same age keys. Each file goes once (30 minutes a run at most; a big first copy carries on in the next run). The
  weekly restore test decrypts one at random. Restoring them is step 7 of `docs/runbooks/restore.md`.
- **Serving.**
  - A file is reached only through a message the person may see.
  - Photos, voice notes and video show in place, with byte ranges so Safari can play them.
  - Everything else downloads, and nothing is ever run as a page (`sandbox` CSP, `nosniff`). LUME doesn't scan
    documents for viruses: it never opens them, it only hands them over.
  - Media are fetched only from Meta's own hosts, so a number's token never goes anywhere else.

## When something's wrong

| What the card says | What to do |
|---|---|
| "WhatsApp stopped letting LUME in. Connect this number again." | The token was revoked, or the number was disconnected in the app. Choose **Connect again**. Photos waiting since then are fetched once it's back. |
| "Whoever connected this number can't see leads any more. Connect it again." | The admin who connected it was paused or lost the permission. Another admin connects it again. Messages wait meanwhile. |
| A photo says "The server's disk is full. LUME will try again." | The disk is 95% full. Free space, choose a shorter "Keep WhatsApp files", or move to a bigger server; waiting files are fetched again by themselves. |
| System health: "LUME can't write WhatsApp files on this server." | The `files` volume isn't mounted (an old `docker-compose.yml`). Update the compose file from this release and `docker compose up -d`. |
| System health: "WhatsApp files haven't reached the backup for over a day." | Check `docker compose logs worker` for `backup complete` and its `files` line, and that the `offsite` remote is reachable. |
| No messages arriving | Check the relay's logs for `/wa/in` and the client's API log for `/whatsapp/in`. A 401 at the client means the relay token differs. |

## What to verify against the test number (before the first client)

These follow Meta's docs; check them on the real thing once:

- the payload shapes of `messages`, `smb_message_echoes` and `history`;
- that the per-account callback address carries echoes and history too;
- the Embedded Signup message event names (`FINISH`, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`);
- that the code exchange works without a `redirect_uri`.
