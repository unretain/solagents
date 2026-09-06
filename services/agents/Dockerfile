# Railway builds this with the REPO ROOT as build context (that is what
# railway.json's dockerfilePath implies), so every COPY path here is relative to
# the repo root, not to this file's directory. Writing `COPY public ./public`
# looks for /public at the root and fails with "not found".
FROM node:22-slim AS build
WORKDIR /app
COPY services/agents/package.json ./
RUN npm install --no-audit --no-fund
COPY services/agents/tsconfig.json ./
COPY services/agents/src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY services/agents/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY services/agents/public ./public

# SQL ships with the image so schema migrations run on boot and `train.js` can
# rewrite the ClickHouse views from here, not only from the box.
COPY postgres ./postgres
COPY clickhouse ./clickhouse
ENV SQL_DIR=/app/clickhouse

# Railway injects PORT; this is the local fallback.
ENV AGENTS_PORT=3002
EXPOSE 3002
CMD ["node", "dist/index.js"]
