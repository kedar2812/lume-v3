# Switching on "Connect with Google"

"Connect with Google" lets a client's admin sign in to Google and pick a sheet in Google's own Picker, instead of sharing the sheet with a service-account email. It's built and tested, and stays **invisible** until the steps below are done. Signing in to LUME itself never changes: email, password and authenticator.

**How it works:**
- Every client runs on their own domain, so Google talks to **one relay** you host: `apps/connect`, at `connect.lumecrm.in`.
- The relay holds the Google client secret and the Picker key.
- It hands each client its grant sealed with that client's own token.
- It **never sees lead data**, only OAuth tokens and the picked file's id and name.

## 1. Google Cloud (once)

1. Create (or reuse) a Google Cloud project for LUME, and enable the **Google Sheets API**, the **Google Drive API** and the **Google Picker API**.
2. **OAuth consent screen:**
   - **External**; app name "LUME"; your support email; the LUME logo (`lume-mark.png`).
   - Authorised domain `lumecrm.in`.
   - **Application home page** `https://lumecrm.in` and **privacy policy** `https://lumecrm.in/privacy` (verification needs both, on the authorised domain, and the privacy policy must say what LUME does with Google data: reads only the sheets a person picks, to bring their rows in as leads).
   - Scope: **only** `https://www.googleapis.com/auth/drive.file`.
   - Submit for verification. `drive.file` is Google's least-sensitive Drive scope, so verification is the light kind.
3. **Credentials → OAuth client ID → Web application:**
   - authorised JavaScript origin `https://connect.lumecrm.in`;
   - authorised redirect URI `https://connect.lumecrm.in/callback`.
   - Keep the client ID and secret.
4. **Credentials → API key:** restrict it to the **Google Picker API** and to the website `https://connect.lumecrm.in`.
5. Note the project **number** (Project settings). It's the Picker's app id.

## 2. The relay (once)

```bash
pnpm --filter @lume/connect build          # makes apps/connect/dist/main.js
docker build -t lume/connect apps/connect  # a tiny node:22 image
```

Run it behind TLS at `connect.lumecrm.in` (any reverse proxy; it listens on 3200), with:

| Variable | Value |
|---|---|
| `RELAY_PUBLIC_URL` | `https://connect.lumecrm.in` |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | From step 1.3 |
| `GOOGLE_PICKER_API_KEY` | From step 1.4 |
| `GOOGLE_PROJECT_NUMBER` | From step 1.5 |
| `RELAY_SECRET` | `openssl rand -base64 36` |
| `RELAY_INSTANCES` | `[{"url":"https://crm.client-a.com","token":"…"}]`, one entry per client (step 3) |

`GET https://connect.lumecrm.in/healthz` should answer `{"status":"ok"}`.

## 3. Each client

1. Generate the client's token: `openssl rand -base64 36`.
2. Add `{ "url": "<the client's LUME address>", "token": "<it>" }` to `RELAY_INSTANCES`, and restart the relay.
3. In the client's `.env`:

   ```
   GOOGLE_OAUTH_RELAY_URL=https://connect.lumecrm.in
   GOOGLE_OAUTH_RELAY_TOKEN=<the same token>
   ```

   Then restart its API.
4. Check it: in the client's Settings → Integrations, Google Sheets shows **Continue with Google** first (Google's own wording for its sign-in button), and the service-account way sits under "Other ways" (only if that server also has a key).

## 4. Google Calendar (Phase 5A)

The same relay connects each person's Google Calendar, read-only, so LUME can keep their meetings with leads. LUME never writes to anyone's calendar, and keeps only events its rules match to leads. Personal events are never stored.

1. In the Google Cloud project, enable the **Google Calendar API**.
2. On the OAuth consent screen, add exactly these two scopes:
   - `https://www.googleapis.com/auth/calendar.events.readonly`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
3. Both are **sensitive** scopes, so Google's verification is the full kind and takes weeks. Start it early. Until it's through:
   - people see Google's "unverified app" screen;
   - the project is capped at **100 people across all clients**.
4. Verification asks for:
   - a short video of the connect flow (Settings → My account → Calendar → Connect);
   - a privacy policy that says LUME reads calendars only to show a person's meetings with leads, and stores nothing else.
5. The OAuth app must be **In production**. A grant made while it's in testing mode expires after 7 days, and that connection then shows "needs connecting again".
6. Nothing changes on the relay or in a client's `.env`: a client that has Connect with Google set up offers Calendar to anyone with **Connect a calendar** (`calendar.connect`).

**A person who removes LUME's access** at Google: their connection shows "needs connecting again". They and every admin hear it once, and the meetings already kept stay.

**Disconnecting** in LUME forgets the grant and every meeting that connection brought. LUME stays listed in the person's Google account (Security → Third-party access) until they remove it there.

## Looking after it

- **Rotating a client's token:** change it in both places (the relay's list and the client's `.env`). Sheets already connected keep working, because their grants are held by Google and are refreshed through the relay with the new token.
- **Removing a client:** take its entry out of `RELAY_INSTANCES`. Its Google-connected sheets stop refreshing, and they show "needs attention" at their next sync.
- **A person who removes LUME's access** in their Google account: that sheet shows "needs attention" ("Google access for this sheet was removed. Connect it again.") with a **Connect again** button. The admin picks the same file in Google's Picker, and the sheet carries on from where it stopped.
- **The relay down** is a passing failure for sheets: they back off and try again, and nothing is lost.
- **Google's limit of 100 refresh tokens per Google account, per OAuth client.** Each Continue with Google asks for consent again (so a grant always comes back), and each consent makes a new refresh token; past 100, Google silently ends the oldest. Someone who connects a great many sheets from one Google account (across all clients) would see the oldest ones ask to **Connect again**. That's rare; if it happens, connect those sheets from another Google account, or share them with the service account instead.
