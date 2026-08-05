FROM node:22-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

# Non-root (Red Hat / enterprise baseline)
RUN groupadd -r hotline && useradd -r -g hotline -d /app -s /sbin/nologin hotline \
  && mkdir -p /app/data /shared \
  && chown -R hotline:hotline /app /shared

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV AGI_PORT=4573

COPY --from=deps --chown=hotline:hotline /app/node_modules ./node_modules
COPY --chown=hotline:hotline package.json package-lock.json ./
COPY --chown=hotline:hotline orchestrator ./orchestrator

USER hotline
EXPOSE 8787 4573
CMD ["./node_modules/.bin/tsx", "orchestrator/src/server.ts"]
