# syntax=docker/dockerfile:1.7
# Единый Dockerfile для всех сервисов МедиаРадар. Контекст сборки — корень репозитория.
#   docker build -f deploy/docker/Dockerfile --target api    -t mediaradar-api .
#   docker build -f deploy/docker/Dockerfile --target worker -t mediaradar-worker .
#   docker build -f deploy/docker/Dockerfile --target web    -t mediaradar-web .
#   docker build -f deploy/docker/Dockerfile --target migrate -t mediaradar-migrate .

ARG NODE_VERSION=22

# ---------- общая сборка монорепозитория ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# API_ORIGIN «запекается» в сборку web (запасной rewrite /api/*; в production /api/* проксирует Caddy)
ARG API_ORIGIN=http://api:4000
ARG NEXT_PUBLIC_WS_URL=
ENV API_ORIGIN=$API_ORIGIN
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_OUTPUT=standalone
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo run build

# Минимальные production-деревья для API и воркера (только нужные node_modules + dist)
RUN pnpm --filter @mediaradar/api deploy --prod --legacy /out/api \
 && pnpm --filter @mediaradar/worker deploy --prod --legacy /out/worker \
 && rm -rf /out/api/src /out/api/test /out/worker/src /out/worker/test

# ---------- API ----------
FROM node:${NODE_VERSION}-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------- воркер ----------
FROM node:${NODE_VERSION}-bookworm-slim AS worker
ENV NODE_ENV=production
ENV WORKER_HEALTH_PORT=4100
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------- веб-портал (Next.js standalone) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ---------- одноразовое задание: миграции БД ----------
FROM build AS migrate
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@mediaradar/db", "migrate"]
