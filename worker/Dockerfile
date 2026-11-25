# syntax=docker/dockerfile:1.7
# Contexto de construcción: raíz del repositorio.
#   docker build -f worker/Dockerfile -t store-worker .

FROM node:22.12.0-alpine3.21 AS deps
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22.12.0-alpine3.21
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=8081
LABEL org.opencontainers.image.title="store-worker" \
      org.opencontainers.image.source="https://github.com/CarlosDanielQuePerez/Distributed-three-tier-store-demo" \
      org.opencontainers.image.version="${APP_VERSION}"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY worker/package.json worker/*.js ./
COPY shared/*.js /shared/
COPY messaging /messaging
USER 1000:1000
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "--import", "./telemetry.js", "index.js"]
