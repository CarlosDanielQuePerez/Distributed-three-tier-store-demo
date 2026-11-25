# syntax=docker/dockerfile:1.7
# Contexto de construcción: raíz del repositorio.
#   docker build -f worker/Dockerfile -t store-worker .

FROM node:22.23.5-alpine3.24 AS deps
WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22.23.5-alpine3.24
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=8081
LABEL org.opencontainers.image.title="store-worker" \
      org.opencontainers.image.source="https://github.com/CarlosDanielQuePerez/Distributed-three-tier-store-demo" \
      org.opencontainers.image.version="${APP_VERSION}"
WORKDIR /app
# npm/npx/corepack/yarn solo hacen falta para instalar (etapa "deps"). Se quitan de la
# imagen final: traen dependencias propias con CVEs (Trivy) y la app arranca con "node".
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /app/node_modules ./node_modules
COPY worker/package.json worker/*.js ./
COPY shared/*.js /shared/
COPY messaging /messaging
USER 1000:1000
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/healthz >/dev/null || exit 1
CMD ["node", "--import", "./telemetry.js", "index.js"]
