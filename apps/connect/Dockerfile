# The relay is one bundled file (`pnpm --filter @lume/connect build`), run by plain Node.
FROM node:22-slim
WORKDIR /app
COPY dist/main.js ./main.js
# Instagram's routing table (RELAY_DATA_DIR=/data, a named volume): a new volume takes this folder's owner.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3200
CMD ["node", "main.js"]
