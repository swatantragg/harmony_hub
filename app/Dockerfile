FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci --include=dev --ignore-scripts

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

# apk upgrade picks up OS patches published after the base image was cut. Without
# it the image is only ever as current as node:22-alpine's last rebuild, and the
# scanner fails the build over an openssl advisory nobody here can act on.
RUN apk upgrade --no-cache \
  && apk add --no-cache dumb-init curl ffmpeg

# npm is a build-time tool. It is not needed to run the server, and leaving it in
# means shipping its whole vendored dependency tree — tar, pacote, sigstore and
# the rest — into production. Those carry their own advisories, none of which are
# reachable from anything this image actually executes, and every one of them
# fails an image scan. Deleting npm removes the code and the false alarms
# together, and takes a package manager out of reach of anything that gets in.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

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
