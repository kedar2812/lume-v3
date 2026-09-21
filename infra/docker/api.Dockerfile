FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/api build
# Native modules are left out of the bundle (scripts/bundle.mjs); install exactly the locked version next to it.
RUN version="$(node -p "require('/src/packages/core/node_modules/@node-rs/argon2/package.json').version")" \
  && mkdir -p /deps && cd /deps && echo '{"private":true}' > package.json \
  && npm install --omit=dev --no-audit --no-fund --loglevel=error "@node-rs/argon2@${version}"

FROM node:22-bookworm-slim
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=512 --enable-source-maps"
WORKDIR /app
COPY --from=build /deps/node_modules ./node_modules
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/packages/core/data ./data
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
