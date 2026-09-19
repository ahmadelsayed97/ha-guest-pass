FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src

ENV GUEST_STORE_FILE=/data/guests.json
EXPOSE 8124
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT:-8124}/health" || exit 1
CMD ["bun", "run", "src/index.ts"]
