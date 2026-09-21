# Build/test toolbox for LUME. Runs on the build host; nothing is installed on the host itself.
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg age rclone shellcheck \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

# Chromium system libraries for Playwright (browsers themselves are cached in the pnpm-store volume).
RUN npx -y playwright@1 install-deps chromium && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_BROWSERS_PATH=/pnpm-store/ms-playwright
