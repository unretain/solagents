# Railway builds this. Multi-stage so the runtime image carries no toolchain.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY public ./public
# Railway injects PORT; AGENTS_PORT is the local-dev fallback.
ENV AGENTS_PORT=3002
EXPOSE 3002
CMD ["node", "dist/index.js"]
