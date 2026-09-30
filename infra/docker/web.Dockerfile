FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/web build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /src/apps/web/.next/standalone ./
COPY --from=build /src/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /src/apps/web/public ./apps/web/public
# A release (licensing L-C): LUME_RELEASE=1 bakes /app/release.json; the version is the image's own.
ARG LUME_RELEASE
ARG LUME_VERSION=dev
ENV LUME_VERSION=$LUME_VERSION
COPY --from=build /src/infra/docker/release-marker.sh /tmp/release-marker.sh
RUN sh /tmp/release-marker.sh "$LUME_RELEASE" "$LUME_VERSION" /app && rm /tmp/release-marker.sh
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
