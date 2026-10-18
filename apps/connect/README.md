# LUME Connect — the "Connect with Google" relay

One small service the owner hosts once (at `connect.lumecrm.in`), for every LUME client. It exists
because each client runs on its own domain, while Google's sign-in must return to one registered
address. It holds the OAuth client secret and the Picker key, runs Google's consent and Picker, and hands
each client its grant sealed with that client's own token. It never sees lead data: only OAuth tokens
and the picked file's id and name.

The whole setup, in order, is in `docs/runbooks/connect-with-google.md`.

Settings (environment):

| Name                                                   | What                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RELAY_PUBLIC_URL`                                     | `https://connect.lumecrm.in`                                                                                                                           |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | The OAuth web client (redirect URI `<RELAY_PUBLIC_URL>/callback`)                                                                                      |
| `GOOGLE_PICKER_API_KEY`                                | An API key restricted to the Picker API and this origin                                                                                                |
| `GOOGLE_PROJECT_NUMBER`                                | The Cloud project's number (the Picker's app id)                                                                                                       |
| `RELAY_SECRET`                                         | 32+ random characters; signs the sign-in state                                                                                                         |
| `RELAY_INSTANCES`                                      | JSON: `[{ "url": "https://crm.client-a.com", "token": "<32+ chars>" }, …]`. The same token goes in that client's `.env` as `GOOGLE_OAUTH_RELAY_TOKEN`. |
| `PORT`                                                 | Default 3200                                                                                                                                           |
| `META_APP_ID`, `META_APP_SECRET`                       | WhatsApp (optional): Meta's app. The secret stays here; no client ever holds it.                                                                       |
| `META_CONFIG_ID`                                       | The Embedded Signup configuration, for existing WhatsApp Business app numbers (coexistence)                                                            |
| `META_VERIFY_TOKEN`                                    | 16+ random characters; what Meta's webhook handshake must send                                                                                         |
| `META_GRAPH_URL`, `META_GRAPH_VERSION`                 | Default `https://graph.facebook.com` and `v23.0`                                                                                                       |

WhatsApp (spec 2026-10-18 §3.3): with the four `META_*` settings, the relay also runs Embedded Signup at `/wa/start`
and passes Meta's deliveries on at `/wa/in/<instance>`: each client's WhatsApp account is subscribed with its own
address there, so the relay keeps no list of numbers and stores nothing. Message text passes through in memory only.
Setup: `docs/runbooks/whatsapp.md`.
