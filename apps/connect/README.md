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
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`             | Instagram (optional): the Instagram product's own app id and secret (API setup with Instagram login). The secret stays here.                           |
| `INSTAGRAM_VERIFY_TOKEN`                               | 16+ random characters; what Meta's Instagram webhook handshake must send                                                                               |
| `RELAY_DATA_DIR`                                       | Needed with Instagram: a folder on a volume for the routing table (account → LUME) and catch-up notes. Never message content.                          |

WhatsApp (spec 2026-10-18 §3.3): with the four `META_*` settings, the relay also runs Embedded Signup at `/wa/start`
and passes Meta's deliveries on at `/wa/in/<instance>`: each client's WhatsApp account is subscribed with its own
address there, so the relay keeps no list of numbers and stores nothing. Message text passes through in memory only.
Setup: `docs/runbooks/whatsapp.md`.

Instagram (`docs/NEW_FEATURES_PLAN.md` §4.2): with the three `INSTAGRAM_*` settings, the relay runs Instagram's sign-in
at `/ig/start` and `/ig/callback`, and passes Meta's deliveries on at `/ig/in`. Instagram has one webhook address for
the whole app, so the relay keeps a routing table (account → LUME) in `RELAY_DATA_DIR`, rebuilt from every LUME on
start. Each LUME gets only its own accounts' entries. A LUME down for over 15 minutes gets a gap note to catch up
from, so it never holds back the others.
