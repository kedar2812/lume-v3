#!/usr/bin/env bash
# Puts the licence server on https://license.lumecrm.in (docs/runbooks/licence-server.md §5).
# Run on the host as root once the DNS A record license → the host resolves publicly.
set -euo pipefail
HOST=${LICENCE_HOST:-license.lumecrm.in}
HOST_IP=${HOST_IP:-200.97.166.16}
SITE=/etc/nginx/sites-available/lume-licence

# Asked of a public resolver: the host's own may still hold an earlier "not found", and Let's Encrypt
# checks from outside anyway.
ip="$(dig +short "$HOST" @1.1.1.1 | tail -1)"
if [ "$ip" != "$HOST_IP" ]; then
  echo "DNS for $HOST doesn't point here yet (got '${ip:-nothing}'). Add the A record, wait a minute, run again." >&2
  exit 1
fi

# 1. Plain HTTP first, so certbot can prove the name.
cat > "$SITE" <<NGINX
server {
    listen 80;
    server_name $HOST;
    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:8480;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
ln -sf "$SITE" /etc/nginx/sites-enabled/lume-licence
nginx -t
systemctl reload nginx

# 2. The certificate; certbot adds TLS and the HTTP→HTTPS redirect to this site only.
certbot --nginx -d "$HOST" --redirect --non-interactive --agree-tos --keep-until-expiring \
  --register-unsafely-without-email
# HSTS on the TLS server block certbot wrote (after its first "listen 443 ssl" line).
if ! grep -q Strict-Transport-Security "$SITE"; then
  awk '{ print } /listen 443 ssl/ && !done { print "    add_header Strict-Transport-Security \"max-age=31536000\" always;"; done = 1 }' \
    "$SITE" > "$SITE.new" && mv "$SITE.new" "$SITE"
fi
nginx -t
systemctl reload nginx

# 3. Checks through this host's nginx (not its resolver): the licence server, the redirect, the other sites.
echo "licence:  $(curl -s -o /dev/null -w '%{http_code}' --resolve "$HOST:443:127.0.0.1" "https://$HOST/healthz")"
echo "redirect: $(curl -s -o /dev/null -w '%{http_code}' --resolve "$HOST:80:127.0.0.1" "http://$HOST/")"
for s in /etc/nginx/sites-enabled/*; do
  name="$(awk '/server_name/{print $2; exit}' "$s" | tr -d ';')"
  [ -z "$name" ] || [ "$name" = "$HOST" ] || [ "$name" = "_" ] && continue
  echo "site $name: $(curl -s -o /dev/null -w '%{http_code}' --resolve "$name:443:127.0.0.1" "https://$name/")"
done
echo "Done. Sign in at https://$HOST with /root/lume-licence/secrets/admin.txt, then change the password, set up a new authenticator, and delete that file."
