FROM node:22-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV AGI_PORT=4573

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY orchestrator ./orchestrator

# tsx is a dep via npm; run the same entry as npm start
EXPOSE 8787 4573
CMD ["./node_modules/.bin/tsx", "orchestrator/src/server.ts"]
