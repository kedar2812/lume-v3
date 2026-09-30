# The fleet: releases, new clients, updates, offboarding

Every client runs the same LUME, on its own server, from versioned images. Nothing about a client is in the
code: its differences are its `.env` and its own database. These scripts run from the owner's machine (a
checkout of the repository with Node 22, bash, ssh and openssl), never on the build host.

| What | Where |
|---|---|
| Who runs LUME, where, which version | `deploy/clients.yml` (committed, no secrets) |
| A client's secrets and inputs | `deploy/clients/<slug>.env` (gitignored; back it up in the password manager) |
| The scripts | `scripts/provision.sh`, `scripts/update.sh`, `scripts/decommission.sh` (each has `--dry-run`) |
| The licence server | `docs/runbooks/licence-server.md` |

## A release

1. Update `CHANGELOG.md` (a `## X.Y.Z — date` entry on top; say which migrations change existing data or
   permissions) and set the same version in the root `package.json`.
2. Commit, wait for CI to pass, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release` workflow builds api, web, worker and caddy as releases (`LUME_RELEASE=1`, the version baked
   in) and pushes them to `ghcr.io/kedar2812/lume-v3/<image>:X.Y.Z`. It refuses a tag that doesn't match
   `package.json`. There is never a `latest`.

A release trusts only the licence keys compiled into it (`packages/core/src/licence/keys.ts`) and refuses to
start with none.

## A new client

1. **Licence:** on license.lumecrm.in, New licence → note the **instance ID** and the **key** (shown once).
2. **Server:** the client buys an Ubuntu 24.04 VPS (2 vCPU, 8 GB), creates the sudo user `lume-deploy` and
   adds LUME's SSH public key to it.
3. **DNS:** add `<slug>.lumecrm.in` → the server's address (an A record).
4. **Registry:** make a read-only GitHub token for this client (packages: read), so it can be revoked alone.
5. **Inventory:** add the client to `deploy/clients.yml`:
   ```yaml
   clients:
     - slug: harbour-clinic
       host: 203.0.113.10
       user: lume-deploy
       version: none
       licence: subscription
       instance: LUME-XXXX-XXXX
       status: new
   ```
6. **Inputs:** `deploy/clients/harbour-clinic.env` (mode 600):
   ```sh
   LUME_LICENSE_KEY=LUME-…            # from step 1
   GHCR_USER=…                        # the token's GitHub user
   GHCR_TOKEN=…                       # from step 4
   OWNER_AGE_RECIPIENT=age1…          # the owner's offline backup key (public half)
   SMTP_URL=smtp://…                  # optional: email (invites, password resets, the digest)
   MAIL_FROM=LUME <lume@example.com>  # optional
   ```
7. **Provision:** `scripts/provision.sh harbour-clinic --dry-run`, read it, then without `--dry-run`. It:
   checks DNS; makes the client's secrets once (kept in its `.env`, never regenerated); hardens the server
   (SSH keys only, ufw 22/80/443, unattended upgrades, fail2ban, Docker); writes `/opt/lume`; logs in to the
   registry with the token on stdin; makes the restore-test key on the server; pulls the pinned version,
   migrates and starts; waits for `https://harbour-clinic.lumecrm.in/healthz`; prints the **setup link and
   token**. The clients file then says `status: active` and the version.
8. **Setup:** send the client the link and token (or sit with them): the owner account, the business, then
   Settings (stages, fields, roles, people, integrations, templates), and optionally an import.
9. The installation checks in at start: its row on license.lumecrm.in turns green.

Running `provision.sh` again is safe: it changes nothing that's already right.

## Updates

```sh
scripts/update.sh 1.1.0 harbour-clinic --dry-run
scripts/update.sh 1.1.0 all
```

For each client: the encrypted backup (as the nightly one, off-site as configured) and a plain dump kept on
the server for this update (`/opt/lume/backups/before-1.1.0.dump`); then pull, migrate, restart, and wait
for health. If health fails, it goes back to the previous version, and restores the dump **only if
migrations ran**. One client's failure never stops the others. The table at the end says what happened to
each; `deploy/clients.yml` keeps each client's real version. Commit it.

A row that ends **NOT HEALTHY** needs you now: sign in to that server (`ssh lume-deploy@<host>`, then
`cd /opt/lume && docker compose ps` and `docker compose logs api`).

## Offboarding a client

1. On license.lumecrm.in: **Suspend** the client. Its LUME shows the pause screen at its next check (or at
   once when its admin presses Check again); its admin can still export everything.
2. Hand the client **Export all data** (leads, notes, activity, follow-ups, users: CSVs and a workbook), and
   get their written confirmation that they have it.
3. `scripts/decommission.sh <slug> --export-confirmed --dry-run`, then without `--dry-run`. It refuses
   unless the installation's own licence says suspended. It removes the stack, its images and volumes (the
   database), `/opt/lume` with its backups, the registry login, and last LUME's key from the deploy user.
   It marks the client `decommissioned` in `deploy/clients.yml` and deletes its local `.env`.
4. By hand, as it reminds you: revoke the client's registry token; remove the DNS record; on the licence
   server, **Decommission** the client (its record stays, marked, for your history).

## The owner's acceptance on a real server

The scripts are tested with stand-ins for ssh, docker and curl (`scripts/fleet/*.test.ts`, in CI) and with
`--dry-run`. Once, on a fresh Ubuntu 24.04 VPS (not the build host):

- [ ] New licence; the VPS with `lume-deploy`; DNS; a registry token; the inventory and inputs.
- [ ] `provision.sh` from nothing to the setup link with no manual step but DNS; setup; the licence row
      turns green.
- [ ] `provision.sh` again: nothing changes.
- [ ] Tag a small release (for example 1.0.1) and `update.sh 1.0.1 all`: updated, the table says so.
- [ ] A deliberately broken release (for example an image that exits at start) and `update.sh`: it rolls
      back to the previous version by itself.
- [ ] Suspend, export, `decommission.sh --export-confirmed`: `docker ps -a`, `docker images`,
      `docker volume ls` and `ls /opt` show nothing of LUME's.
