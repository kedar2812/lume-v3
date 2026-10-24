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
3. **Facebook Login for Business → Templates:** use **"WhatsApp embedded sign-up configuration with 60-day expiry
   token"** (a new configuration offers only "General", not Embedded Signup), product **WhatsApp Cloud API**, with
   `whatsapp_business_management` and `whatsapp_business_messaging`. Note its **Configuration ID**. Coexistence is asked
   for by the signup page itself (`featureType: whatsapp_business_app_onboarding`).
   - **Its tokens last 60 days.** Each client's LUME refreshes a number's token through the relay (`/wa/refresh`,
     which holds the app secret) once it's 30 days old, hourly until it works. If Meta refuses it, the number shows
     "WhatsApp stopped letting LUME in. Connect this number again."
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

## Reply from LUME (plan W3a, 2026-10-19)

- **The switch.** Off by default. An admin switches it on in Settings → Integrations → WhatsApp → **Reply from
  LUME** (audited). It only works while WhatsApp is on and in the plan.
- **Who may reply.** Anyone with `messages.send` who can see the lead, the same rule as tap-to-send. The message goes
  from the number the lead last wrote to, shows on that phone too, and the thread says who sent it.
- **When.** Only within WhatsApp's 24 hours of the lead's last message on that number. LUME checks again when Send is
  tapped. Outside that window the box shows the reason and the usual **Message** button (tap-to-send on this device).
  Approved templates for later messages are W3b.
- **What.** Words up to 4,096 characters, or a file with up to 1,024 characters of words. Allowed files: photos (JPEG,
  PNG, 5 MB), videos (MP4, 3GPP, 16 MB), voice notes and audio (16 MB, no words), and documents (PDF, Word, Excel,
  PowerPoint, text; 25 MB). The type is read from the file's bytes, never from its name. A file attached and never
  sent is cleared after a day.
- **How it goes.**
  1. The message is queued, and the `whatsapp.send` queue sends it as the person who tapped Send (8 senders).
  2. A file is uploaded to Meta once per number and content, then reused for 25 days.
  3. Once Meta takes the message, it counts as a send: the lead's last message time, first contact, the follow-up
     done, the stage's move.
  4. Meta's statuses move it forward: Sent, Delivered, Read.
- **Never twice.**
  - A double tap or a retried request is one message, because each message carries its own key.
  - A message found "sending" for over 2 minutes (a crash mid-send) is failed with "LUME couldn't tell whether this
    went. Check the phone before sending it again." It is never sent again by itself.
- **When Meta says no.** Each refusal is put into words on the message, with Try again for words.
  - Busy or rate limited: tried 5 times with backoff.
  - A revoked token: the number goes to "needs attention".
- **Limits.** 30 messages a minute and 600 an hour for each person: "That's a lot of messages at once. Wait a
  minute and send again."
- **Cost.** Replies within the 24 hours are Meta's service messages. Meta's pricing is to verify against the
  business's own account before telling clients a number.

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

## The file library and file links (W3b-1, 2026-10-20)

- **What it is.** Settings → Files (admins with `templates.manage`): brochures, price lists and photos the business
  sends often. Anyone who may use templates can attach one from a lead's reply box (Attach → From your files); nothing
  is uploaded again.
- **Where they live.** In the same `files` volume as WhatsApp's own files, kept once by content, so the same brochure
  in the library and on 150 messages is one file. The library holds its own claim on each file: "Keep WhatsApp files
  for" never removes a library file, and archiving one keeps it on disk for the messages that already sent it. The
  6-hourly off-site copy and the restore steps cover library files with no extra step.
- **Share by link.** A file's switch gives it an unguessable address (`/f/` and 43 random characters) for when
  WhatsApp isn't connected; the send sheet's **Add a file** puts it under the message. Anyone with the address can
  open the file, no sign-in, 60 opens a minute from one address. The address only works while the switch is on and the
  file isn't archived; otherwise it answers exactly as an address that never existed. Switching it on again gives the
  same address back.
- **A client's proxy.** `/f/*` must reach the API, as `infra/Caddyfile` does (it's beside `/api/*`). A client on an
  older Caddyfile gets the web app's "not found" for every link: update the Caddyfile from this release and reload.
- **A link that leaked.** The admin switches **Share by link** off. Anyone with the old address sees nothing from that
  moment (a browser that already opened it may keep its copy for up to 5 minutes). Switching it back on brings the
  same address back, so to share the file again under a new address: archive it, then add it again (a new upload is a
  new address).

## Approved templates and sending beyond 24 hours (W3b-2, 2026-10-20)

- **What it is.** In a saved template, **WhatsApp approval** sends its words to WhatsApp for review, once for each
  WhatsApp business account with a connected number. Once approved, the reply box offers it for a lead outside the 24
  hours, or one who never wrote, in the lead's words, with what's missing and about what WhatsApp charges. It shows
  only where WhatsApp is set up and switched on.
- **Server setting.** `LUME_META_APP_ID` (LUME's Meta app id, not a secret) in the client's inputs, passed to the api.
  Only a template with a file at the top needs it; without it, LUME says so and text templates still go.
- **WhatsApp's answer.** It comes by webhook through the relay (nothing extra on the relay). If one is lost, LUME asks
  WhatsApp every 15 minutes about anything pending for over 10. Approval usually takes minutes to a day. The person
  who submitted it and the admins hear the answer once, in the bell.
- **Editing an approved template** makes a new version: the approved one keeps sending as approved until the new words
  are submitted and approved. A turned-down version can't go again as it is: change the words, save, submit again.
- **What it costs.** WhatsApp bills the client's own Meta account for every template, inside the 24 hours too (since
  2026-10-01). LUME shows "about" the rate from its rate card (`packages/core/src/whatsapp/rates.ts`, India marketing
  ₹0.86 + GST, read 2026-10-18). To add a market or category: read Meta's current rate card, add the rate with the day
  you read it, and ship. A rate LUME doesn't have shows no amount, never a guess.
- **The monthly limit.** Paid WhatsApp messages a month: the lower of the plan's (licence dashboard, Plan limits; needs
  the licence server and a LUME that accepts `plan3`) and the admin's own (Settings → Messages). Counted on the
  business's clock, every lead's. At 80% the admins hear it once that month; at the limit nothing more goes and LUME
  says so with the numbers.
- **A lead who turned off marketing (Meta's 131050).** The send fails with "This person turned off marketing messages
  from you on WhatsApp.", the lead is marked, and no marketing template is offered for them again (reminders still
  are). Nothing to fix: it's the lead's choice.
- **A template WhatsApp no longer has as approved (132000, 132001).** The send fails in words and the template shows
  "Didn't reach WhatsApp": submit it again.

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
