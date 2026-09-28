FROM oven/bun:1.4.2-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public

ENV GUEST_STORE_FILE=/data/guests.json
EXPOSE 8124
ENTRYPOINT []
CMD ["bun", "run", "src/index.ts"]
