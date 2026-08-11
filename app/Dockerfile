# GCloud — one image, one process, one port.
#
# The API serves the built client from the same origin (§4): the browser sees one hostname.
# The only other host it ever talks to is googleapis.com, directly, when it PUTs upload
# bytes to a Drive resumable session — downloads come back through this container, because
# Google Drive offers no self-authorising expiring link for a server credential
# (see server/src/services/signing.js).
#
#   docker build -t gcloud:latest .
#   docker run --env-file .env -p 8100:8100 gcloud:latest

# ── Stage 1: install every dependency, including dev, and build the client ───
FROM node:22-alpine AS build
WORKDIR /app

# Only the manifests first, so a change to source code does not invalidate the install
# layer. This is the difference between a 4-second rebuild and a 90-second one.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY client/ client/
RUN npm run --workspace client build

# ── Stage 2: production dependencies only ───────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# The client is already built; its toolchain has no business in the runtime image.
RUN npm ci --omit=dev --workspace server --include-workspace-root \
  && npm cache clean --force \
  # Workspaces hoist to the root node_modules, so server/node_modules exists only when a
  # version conflict forced something to nest. Creating it unconditionally keeps the COPY
  # in the runtime stage from depending on whether that happened.
  && mkdir -p server/node_modules

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# dumb-init gives the process a real PID 1, so SIGTERM reaches Node and the shutdown
# handler gets to flush pending writes to MongoDB before the container dies.
# ffmpeg is here for the optional perceptual de-duplication tier (§10.12), which decodes a
# handful of frames per video to find the same footage at different resolutions. It adds
# about 80 MB to the image; drop it if DEDUPE_PERCEPTUAL will always be false, and the other
# three duplicate tiers carry on working without it.
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

# node:alpine ships an unprivileged `node` user. Nothing here needs to write to disk —
# the catalogue lives in MongoDB and the bytes live in Google Drive. Downloads are streamed
# through this process rather than buffered, so that stays true even for a 40 GB master.
RUN chown -R node:node /app
USER node

EXPOSE 8100

# Reports unhealthy while MongoDB *or* Google Drive is unreachable. The second half matters:
# a container whose refresh token has expired can still answer every JSON route while being
# unable to serve a single file, and an orchestrator needs to know that before it sends
# traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" | grep -q '"ok":true' || exit 1

WORKDIR /app/server
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
