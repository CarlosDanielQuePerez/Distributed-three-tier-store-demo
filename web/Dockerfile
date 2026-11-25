# syntax=docker/dockerfile:1.7
# Imagen de presentación para Kubernetes: Nginx con ngx_otel_module, sin root.
#   docker build -f web/Dockerfile -t store-web .
FROM nginx:1.31.0-alpine-otel

ARG APP_VERSION=dev
LABEL org.opencontainers.image.title="store-web" \
      org.opencontainers.image.source="https://github.com/CarlosDanielQuePerez/Distributed-three-tier-store-demo" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV API_UPSTREAM=store-api:8080 \
    OTEL_EXPORTER_OTLP_GRPC_ENDPOINT=otel-agent.observability.svc.cluster.local:4317 \
    OTEL_EXPORTER_OTLP_HTTP_ENDPOINT=http://otel-agent.observability.svc.cluster.local:4318 \
    OTEL_SERVICE_NAME=store-web \
    GRAFANA_URL="" \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

RUN rm -f /etc/nginx/conf.d/default.conf \
 && rm -f /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh \
 && mkdir -p /etc/nginx/templates \
 && chown -R 101:101 /etc/nginx/conf.d /var/cache/nginx

COPY web/docker/nginx.conf /etc/nginx/nginx.conf
COPY web/docker/default.conf.template /etc/nginx/templates/default.conf.template
COPY web/site1/index.html /usr/share/nginx/html/index.html
COPY web/catalog.js web/catalog.css /usr/share/nginx/html/

USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
