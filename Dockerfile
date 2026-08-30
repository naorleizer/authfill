# syntax=docker/dockerfile:1
# AuthFill self-hosted proxy — runs the Cloudflare Worker (Hono) locally via wrangler dev.
#
# Why wrangler dev and not plain Node/Hono:
#   cf-imap (the IMAP client the proxy uses) imports `connect` from
#   `cloudflare:sockets`, a runtime API that ONLY exists inside Cloudflare's
#   workerd runtime. Plain Node.js does not provide it. wrangler dev runs a
#   local workerd that supports outbound `cloudflare:sockets` TCP, so the
#   proxy works unmodified.

FROM node:22.14.0-bookworm-slim AS base

# pnpm is needed for the monorepo workspace install
RUN corepack enable && corepack prepare pnpm@8.15.6 --activate

# git: needed by some pnpm workspace resolution; ca-certificates: outbound TLS
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- deps layer ----
# Copy the whole repo so workspace resolution (path aliases, tsconfig extends,
# workspace:* deps) all works. The repo is small so caching impact is minor.
COPY . .

# Install only what the workspace needs. --no-frozen-lockfile because the
# lockfile was generated on the host and may not match the container platform.
RUN pnpm install --no-frozen-lockfile

WORKDIR /app/apps/proxy

# PUBLIC_WEB_URL is the only declared wrangler binding; the proxy does not use
# it at runtime but wrangler warns if it is absent. IMAP credentials are sent
# per-connection over the WebSocket, not via env vars.
ENV PUBLIC_WEB_URL=http://localhost:3000
ENV NODE_ENV=development

EXPOSE 4000

# Healthcheck hits the /health endpoint wrangler serves.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Bind to 0.0.0.0 so the container port is reachable from the host.
# We intentionally do NOT use --remote (that requires Cloudflare login).
CMD ["npx", "wrangler", "dev", "--port", "4000", "--ip", "0.0.0.0"]