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
4. Check it: in the client's Settings → Integrations, Google Sheets shows **Connect with Google** first, and the service-account way sits under "Other ways" (only if that server also has a key).

## Looking after it

- **Rotating a client's token:** change it in both places (the relay's list and the client's `.env`). Sheets already connected keep working, because their grants are held by Google and are refreshed through the relay with the new token.
- **Removing a client:** take its entry out of `RELAY_INSTANCES`. Its Google-connected sheets stop refreshing, and they show "needs attention" at their next sync.
- **A person who removes LUME's access** in their Google account: that sheet shows "needs attention" ("Google access for this sheet was removed. Connect it again.").
- **The relay down** is a passing failure for sheets: they back off and try again, and nothing is lost.
