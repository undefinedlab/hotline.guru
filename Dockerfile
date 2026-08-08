FROM node:22-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# --legacy-peer-deps: @circle-fin/developer-controlled-wallets has a peerOptional on
# @solana/codecs-strings@^2 while @circle-fin/adapter-circle-wallets pulls @solana/kit@5
# (codecs-strings@5.5.1). Solana packages on an Arc/EVM-only path — nothing we call
# touches them. Drop the flag when Circle aligns those ranges.
RUN npm ci --omit=dev --legacy-peer-deps

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
