# Node 22 is the minimum supported runtime and retains the linux/arm/v7
# manifest required by the multi-architecture Docker jobs.
FROM node:25-bookworm-slim AS builder

WORKDIR /app

RUN sed -i \
  -e 's|deb.debian.org|mirrors.aliyun.com|g' \
  -e 's|security.debian.org|mirrors.aliyun.com|g' \
  /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm rebuild esbuild sharp better-sqlite3 --no-audit --no-fund

COPY . .
RUN npm run build:web && npm run build:server
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:25-bookworm-slim

WORKDIR /app

RUN sed -i \
  -e 's|deb.debian.org|mirrors.aliyun.com|g' \
  -e 's|security.debian.org|mirrors.aliyun.com|g' \
  /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/drizzle ./drizzle

RUN mkdir -p /app/data

EXPOSE 4000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["sh", "-c", "node dist/server/db/migrate.js && node dist/server/index.js"]
