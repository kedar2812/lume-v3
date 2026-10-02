# The licence server (license.lumecrm.in)

The licence server holds every client's licence, answers each LUME installation's check, and is where you
mark payments, send reminders, rotate keys and pause a LUME. It is **one** server for the whole fleet, and
it is not part of any client's LUME.

- Code: `apps/licence` (Next.js, its own Postgres). Image: `infra/docker/licence.Dockerfile`.
- Compose project: `infra/licence/docker-compose.yml`, deployed to `/root/lume-licence` on the owner's host.
- The app listens on **127.0.0.1:8480 only**. Nothing reaches it from outside until you add the nginx site
  below (step 5): that step edits the host's nginx, which also serves another site, so it's yours to do.

## What lives where

| Thing | Where | Notes |
|---|---|---|
| Signing key (private) | `/root/lume-licence/secrets/signing.pem` | mode 600. Never copy it anywhere else. Back it up **offline**. |
| Signing key (public) | `packages/core/src/licence/keys.ts` (`LICENCE_KEYS`) | Committed. Every LUME release trusts only the keys listed there. |
| Database password, key id | `/root/lume-licence/.env` | mode 600. |
| Master key | `/root/lume-licence/secrets/master.key` | mode 600. It seals your two-step secret: back it up offline with the signing key. |
| Admin's first password and two-step secret | `/root/lume-licence/secrets/admin.txt` | Written once at deploy. Sign in, change the password and set up a new authenticator, then delete the file. |
| Data | the `lume-licence_pgdata` Docker volume | Clients, licences, prices, payments, check-ins (180 days), events. |

## 1. Build the image

On the host, from a checkout of the repository:

```sh
docker build -f infra/docker/licence.Dockerfile -t lume-licence:0.1.0 -t lume-licence:latest .
```

## 2. Secrets (once)

```sh
mkdir -p /root/lume-licence/secrets && chmod 700 /root/lume-licence /root/lume-licence/secrets
cp infra/licence/docker-compose.yml /root/lume-licence/
cd /root/lume-licence
umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
LICENCE_KID=lume-1
EOF
# The master key is a file the app reads (an environment variable would show in `docker inspect`).
openssl rand -base64 32 > secrets/master.key
# The signing key pair: the private key stays here; the public key is printed.
docker run --rm --user 0 -v /root/lume-licence/secrets:/out lume-licence:latest \
  node apps/licence/scripts/keygen.mjs /out/signing.pem --kid lume-1
chown 1000:1000 secrets/signing.pem secrets/master.key   # the app runs as the image's "node" user
```

Copy the printed `"lume-1": "…"` line into `LICENCE_KEYS` in `packages/core/src/licence/keys.ts`, commit,
and cut a LUME release: from then on every release accepts this server's answers. **keygen refuses to run
twice** against the same file: a new key would orphan every installation that trusts the old one. To
rotate the signing key, make a second key with a new id (`--kid lume-2`), add it to `LICENCE_KEYS`
**alongside** the first, release, update the fleet, and only then switch `LICENCE_KID` here.

## 3. Start

```sh
cd /root/lume-licence && docker compose up -d
docker compose ps   # db healthy, migrate exited 0, app healthy
curl -fsS http://127.0.0.1:8480/healthz
```

## 4. The admin (once)

```sh
cd /root/lume-licence
docker compose run --rm -it app node apps/licence/dist/admin-create.mjs you@example.com
```

It asks for a password (12 characters or more) and prints the two-step secret: add it to an authenticator
app. There is one admin (R4). Every sign-in, good or bad, is logged in `sign_ins`.

## 5. The public side: nginx and the certificate (owner)

Point `license.lumecrm.in` at the host (an A record), then run `infra/licence/go-public.sh` on the host as
root (copy it to `/root/lume-licence/`). It checks the name resolves publicly, writes the nginx site below,
asks certbot for the certificate and the HTTP→HTTPS redirect, adds HSTS, and checks the licence server and the
host's other site afterwards. Done on the owner's host on 2026-10-02. By hand, the site is:

```nginx
server {
    listen 80;
    server_name license.lumecrm.in;
    location / { return 301 https://$host$request_uri; }
}
server {
    listen 443 ssl http2;
    server_name license.lumecrm.in;
    ssl_certificate     /etc/letsencrypt/live/license.lumecrm.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/license.lumecrm.in/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:8480;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Then `certbot --nginx -d license.lumecrm.in` (or your usual way), `nginx -t && systemctl reload nginx`.
The app trusts `X-Real-IP` for its per-address limits: it's safe because only nginx can reach 127.0.0.1:8480.

## 6. Backups

The licence database is small; back it up daily, keep 30 days, and copy it off the host:

```sh
# /etc/cron.d/lume-licence-backup (owner's step: it's the host's cron)
15 3 * * * root cd /root/lume-licence && mkdir -p backups && docker compose exec -T db pg_dump -U licence -Fc licence > backups/licence-$(date +\%F).dump && find backups -name 'licence-*.dump' -mtime +30 -delete
```

Restore: `docker compose exec -T db pg_restore -U licence -d licence --clean < backups/licence-YYYY-MM-DD.dump`.
Back up `secrets/signing.pem`, `secrets/master.key` and `.env` separately, offline, once: without the
signing key no new answer can be signed, and without the master key the admin's two-step can't be opened.

## 7. Update

Build the new image (step 1) with its version tag, then `LICENCE_IMAGE=lume-licence:<version> docker compose up -d`.

**Upgrading from a master key in `.env`** (servers set up before 2026-10-01): the compose file now reads the key
from `secrets/master.key`. Move the *same* key there before `up -d` — a new one would lock the admin out (it
seals their two-step secret):

```sh
cd /root/lume-licence
cp infra/licence/docker-compose.yml .   # from the new checkout
( umask 077; grep '^LICENCE_MASTER_KEY=' .env | cut -d= -f2- > secrets/master.key )
test -s secrets/master.key && chown 1000:1000 secrets/master.key && chmod 600 secrets/master.key
sed -i '/^LICENCE_MASTER_KEY=/d' .env
docker compose up -d
```

If the app stops with "LICENCE_MASTER_KEY_FILE … is a folder", the file was missing when compose started
(Docker made a folder in its place): `rmdir secrets/master.key`, then the lines above.
`migrate` runs first; the app starts only if it succeeds. Roll back by starting the previous tag (migrations
are forward-only and additive).

## 8. A new client, end to end

1. **Clients → New licence**: name, country (and state in India, or city), plan and price, how they found LUME.
2. The sheet shows the **licence key and instance ID once**. Put them in the client's `.env`:
   `LUME_INSTANCE_ID=…` and `LUME_LICENSE_KEY=…` (the release image already points at
   `https://license.lumecrm.in`).
3. The installation checks in at start, every 6 hours, and at sign-in when its last check is stale. Its row
   turns from "Not yet" to a green dot.
4. **Mark paid** when money arrives: paid until moves on one period, the payment keeps that day's rate.

If an installation can't reach the licence server it keeps working: 24 hours on it shows its admins a grace
banner, 7 days on it's read-only (never locked; everyone can still export everything).

## What each state does to an installation

| State here | Why | The installation |
|---|---|---|
| Active | paid, perpetual, or a trial not over | works |
| Grace | paid until up to 7 days ago | works; admins see an amber banner |
| Read-only | 8+ days late, or a trial ended | looks, exports, signs in; no changes |
| Suspended | Pause this LUME | a pause screen; admins can still export everything |

## Checking it

- `curl -fsS http://127.0.0.1:8480/healthz` → `ok`.
- A check by hand (from the host) answers 401 for an unknown key: that's right, and says nothing more.
- Exchange rates refresh once a day from open.er-api.com; if it's down the last rates stand and Analytics says
  how old they are.
