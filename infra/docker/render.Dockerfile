# LUME's render service (apps/render): thumbnails of the business's files and Office files as PDFs.
# The tools are Debian's own packages; the service is one bundled file with no npm dependencies.
FROM node:22-bookworm-slim AS tools
# Noto core covers Latin, Devanagari, Arabic and the other scripts LUME's clients write in; DejaVu and Liberation stand
# in for the fonts Office files ask for by name (Arial, Times New Roman, Calibri's metrics).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
    poppler-utils ffmpeg libvips-tools \
    fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

FROM tools AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @lume/render build

# `docker build --target test`: the service against the real tools, as the user it runs as.
FROM build AS test
RUN chown -R node:node /src/apps/render
USER node
RUN cd apps/render && npx vitest run --config vitest.image.config.ts

FROM tools
ENV NODE_ENV=production NODE_OPTIONS="--max-old-space-size=256 --enable-source-maps"
WORKDIR /app
COPY --from=build /src/apps/render/dist ./dist
USER node
EXPOSE 3020
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3020/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
