#!/usr/bin/env bash
# Genera los Secrets de la plataforma con contraseñas aleatorias.
#
#   scripts/generate-secrets.sh dev            → deploy/secrets/dev/store-secrets.sops.yaml (cifrado con SOPS)
#   scripts/generate-secrets.sh dev --apply    → los aplica directo con kubectl (clúster local sin Flux/SOPS)
#
# Las mismas contraseñas se escriben en store-data (las usan los operadores) y en store
# (las usan la API y el worker), porque un Secret no se puede leer entre namespaces.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV=${1:?Uso: $0 <dev|prod> [--apply]}
MODE=${2:-}
OUT_DIR=deploy/secrets/$ENV
OUT=$OUT_DIR/store-secrets.sops.yaml
mkdir -p "$OUT_DIR"

if [ "$MODE" != "--apply" ] && [ -f "$OUT" ]; then
  echo "$OUT ya existe; bórralo si quieres regenerar las contraseñas." >&2
  exit 1
fi

rand() { openssl rand -hex 16; }
MARIADB_ROOT=$(rand); MARIADB_APP=$(rand); MARIADB_MIGRATOR=$(rand)
MONGO_ADMIN=$(rand); MONGO_APP=$(rand)
REDIS=$(rand); RABBIT=$(rand); ADMIN_TOKEN=$(rand); GRAFANA=$(rand)
RABBIT_HOST=store-rabbitmq.store-data.svc.cluster.local

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<YAML
apiVersion: v1
kind: Secret
metadata: { name: mariadb-credentials, namespace: store-data }
type: Opaque
stringData:
  root-password: "$MARIADB_ROOT"
  app-password: "$MARIADB_APP"
  migration-password: "$MARIADB_MIGRATOR"
---
apiVersion: v1
kind: Secret
metadata: { name: mongodb-users, namespace: store-data }
type: Opaque
stringData:
  admin-password: "$MONGO_ADMIN"
  app-password: "$MONGO_APP"
---
apiVersion: v1
kind: Secret
metadata: { name: redis-credentials, namespace: store-data }
type: Opaque
stringData:
  password: "$REDIS"
---
# Formato Service Binding que exige el RabbitMQ Cluster Operator (secretBackend.externalSecret).
apiVersion: v1
kind: Secret
metadata: { name: rabbitmq-credentials, namespace: store-data }
type: Opaque
stringData:
  username: store_app
  password: "$RABBIT"
  host: $RABBIT_HOST
  port: "5672"
  provider: rabbitmq
  type: rabbitmq
  default_user.conf: |
    default_user = store_app
    default_pass = $RABBIT
---
apiVersion: v1
kind: Secret
metadata: { name: store-app-secrets, namespace: store }
type: Opaque
stringData:
  DB_PASSWORD: "$MARIADB_APP"
  DB_MIGRATION_PASSWORD: "$MARIADB_MIGRATOR"
  MONGO_PASSWORD: "$MONGO_APP"
  REDIS_PASSWORD: "$REDIS"
  RABBITMQ_URL: "amqp://store_app:$RABBIT@$RABBIT_HOST:5672"
  RABBITMQ_MANAGEMENT_URL: "http://store_app:$RABBIT@$RABBIT_HOST:15672"
  API_ADMIN_TOKEN: "$ADMIN_TOKEN"
---
apiVersion: v1
kind: Secret
metadata: { name: grafana-admin, namespace: observability }
type: Opaque
stringData:
  admin-user: admin
  admin-password: "$GRAFANA"
YAML

if [ "$MODE" = "--apply" ]; then
  KC=(kubectl ${KUBECTL_CONTEXT:+--context "$KUBECTL_CONTEXT"})
  for ns in store store-data observability; do "${KC[@]}" create namespace "$ns" --dry-run=client -o yaml | "${KC[@]}" apply -f - >/dev/null; done
  "${KC[@]}" apply -f "$TMP"
  echo "Secrets aplicados. Token de administración de la API: $ADMIN_TOKEN"
  exit 0
fi

command -v sops >/dev/null || { echo "Instala sops (https://github.com/getsops/sops) o usa --apply." >&2; exit 1; }
grep -q "age1replacewithyourpublickey" .sops.yaml && { echo "Pon tu llave pública age en .sops.yaml primero." >&2; exit 1; }
cp "$TMP" "$OUT"
sops --encrypt --in-place "$OUT"
echo "Escrito $OUT (cifrado). Token de administración de la API: $ADMIN_TOKEN"
