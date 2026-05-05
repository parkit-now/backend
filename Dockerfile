# syntax=docker/dockerfile:1.7

# ---------- Builder ----------
FROM oven/bun:1.1-debian AS builder

WORKDIR /app

# Bring lockfile + manifests first to maximize layer caching.
COPY package.json bun.lock* ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# `bun install` runs `prisma generate` via postinstall and emits the
# Prisma client into node_modules — keeps the runner image self-contained.
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN bun run build

# ---------- Runner ----------
FROM oven/bun:1.1-debian AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json bun.lock* ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN bun install --frozen-lockfile --production

COPY --from=builder /app/dist ./dist

EXPOSE 3000

# Migrations are applied out-of-band by `supabase db push --linked` in CI.
# The container only runs the API.
CMD ["bun", "run", "dist/main.js"]
