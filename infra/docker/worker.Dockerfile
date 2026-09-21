FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/worker build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg age rclone \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512 --enable-source-maps"
WORKDIR /app
COPY --from=build /src/apps/worker/dist ./dist
COPY --from=build /src/packages/db/migrations ./migrations
COPY --from=build /src/infra/scripts/backup.sh /src/infra/scripts/restore-test.sh ./scripts/
# Owned by node so a fresh named volume mounted here inherits writable ownership.
RUN install -d -o node -g node /var/lib/lume/offsite
USER node
CMD ["node", "dist/main.js"]
