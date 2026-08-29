FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci --ignore-scripts

COPY client/ client/
RUN npm run --workspace client build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci --omit=dev --ignore-scripts --workspace server --include-workspace-root \
  && npm cache clean --force \
  && mkdir -p server/node_modules

FROM node:22-alpine AS runtime

RUN apk add --no-cache dumb-init curl ffmpeg

ENV NODE_ENV=production \
    PORT=8100 \
    CLIENT_DIST=/app/client/dist

WORKDIR /app

COPY --from=deps  /app/node_modules        ./node_modules
COPY --from=deps  /app/server/node_modules ./server/node_modules
COPY --from=build /app/client/dist         ./client/dist
COPY package.json ./
COPY server/package.json ./server/
COPY server/src ./server/src
COPY infra ./infra
COPY scripts ./scripts

RUN chown -R root:root /app && chmod -R a-w /app
USER node

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" | grep -q '"live":true' || exit 1

WORKDIR /app/server
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
