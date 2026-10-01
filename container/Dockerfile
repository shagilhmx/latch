# Deployed path for the Latch integration runner (plan step 4).
# Local dev and tests run the same code directly via `npm run integration`.
# Requires Node 24+ (native TypeScript type stripping).
FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/shared ./src/shared
COPY src/integration ./src/integration

ENV LATCH_BASE_URL=""
CMD ["node", "src/integration/cli.ts"]
