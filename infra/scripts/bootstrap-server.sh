#!/usr/bin/env bash
# Harden a fresh Ubuntu 24.04 LUME server (report §12.6). Idempotent. NEVER run on the shared build host.
# Usage: sudo bash bootstrap-server.sh [--dry-run] [--deploy-key "ssh-ed25519 AAAA… name"]
set -euo pipefail

DRY=false
DEPLOY_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=true ;;
    --deploy-key) DEPLOY_KEY="${2:?}"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

run() { if $DRY; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
write() { # write <path> <mode> <content>
  if $DRY; then printf '[dry-run] write %s (%s)\n' "$1" "$2"; return; fi
  if [ -f "$1" ] && [ "$(cat "$1")" = "$3" ]; then return; fi
  install -m "$2" /dev/null "$1" && printf '%s\n' "$3" > "$1"
}
step() { printf '\n== %s\n' "$1"; }

# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "Ubuntu 24.04 required (found ${PRETTY_NAME:-unknown})" >&2; exit 1
fi
[ "$(id -u)" = 0 ] || $DRY || { echo "run as root" >&2; exit 1; }

step "packages"
run apt-get update -q
run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades chrony

step "deploy user"
if ! id deploy >/dev/null 2>&1; then run adduser --disabled-password --gecos "" deploy; fi
run usermod -aG sudo deploy
if [ -n "$DEPLOY_KEY" ]; then
  run install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
  if $DRY || ! grep -qxF "$DEPLOY_KEY" /home/deploy/.ssh/authorized_keys 2>/dev/null; then
    if $DRY; then echo "[dry-run] add deploy key"; else printf '%s\n' "$DEPLOY_KEY" >> /home/deploy/.ssh/authorized_keys; fi
  fi
  run chown deploy:deploy /home/deploy/.ssh/authorized_keys
  run chmod 600 /home/deploy/.ssh/authorized_keys
fi

step "ssh: key-only, no root"
if ! $DRY && [ -z "$DEPLOY_KEY" ] && [ ! -s /home/deploy/.ssh/authorized_keys ]; then
  echo "refusing to disable root/password login: deploy has no SSH key (pass --deploy-key)" >&2; exit 1
fi
write /etc/ssh/sshd_config.d/10-lume.conf 644 "PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3"
run sshd -t
run systemctl reload ssh

step "firewall"
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow 22/tcp
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw --force enable

step "fail2ban, updates, time"
write /etc/fail2ban/jail.d/lume.local 644 "[sshd]
enabled = true
maxretry = 5
bantime = 1h"
run systemctl enable --now fail2ban chrony unattended-upgrades
run systemctl restart fail2ban

step "docker"
if ! command -v docker >/dev/null 2>&1; then
  run install -d -m 0755 /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  write /etc/apt/sources.list.d/docker.list 644 "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable"
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
write /etc/docker/daemon.json 644 '{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "no-new-privileges": true,
  "live-restore": true
}'
run usermod -aG docker deploy
run systemctl restart docker

step "swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -f /swapfile ] || run fallocate -l 2G /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab 2>/dev/null || { if $DRY; then echo "[dry-run] add /swapfile to fstab"; else echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi; }

step "LUME directories"
run install -d -m 750 -o deploy -g deploy /srv/lume
run install -d -m 700 -o 1000 -g 1000 /srv/lume/secrets

echo
if $DRY; then echo "bootstrap dry run complete: nothing changed"; else echo "bootstrap complete"; fi
