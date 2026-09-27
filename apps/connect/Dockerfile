# The relay is one bundled file (`pnpm --filter @lume/connect build`), run by plain Node.
FROM node:22-slim
WORKDIR /app
COPY dist/main.js ./main.js
USER node
EXPOSE 3200
CMD ["node", "main.js"]
