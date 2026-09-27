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
