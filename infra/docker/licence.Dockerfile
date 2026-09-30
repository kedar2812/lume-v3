# The licence server (license.lumecrm.in, licensing L-B): its own image, never part of a client's LUME.
FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/licence build
# The command-line bundles (migrate, admin-create) leave argon2 out (scripts/bundle.mjs): install the locked
# version next to them.
RUN version="$(node -p "require('/src/packages/core/node_modules/@node-rs/argon2/package.json').version")" \
  && mkdir -p /deps && cd /deps && echo '{"private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund --loglevel=error "@node-rs/argon2@${version}"

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8480
WORKDIR /app
COPY --from=build /src/apps/licence/.next/standalone ./
COPY --from=build /src/apps/licence/.next/static ./apps/licence/.next/static
COPY --from=build /src/apps/licence/public ./apps/licence/public
COPY --from=build /src/apps/licence/dist ./apps/licence/dist
COPY --from=build /deps/node_modules ./apps/licence/dist/node_modules
COPY --from=build /src/apps/licence/migrations ./apps/licence/migrations
COPY --from=build /src/apps/licence/scripts/keygen.mjs ./apps/licence/scripts/keygen.mjs
USER node
EXPOSE 8480
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8480/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/licence/server.js"]
