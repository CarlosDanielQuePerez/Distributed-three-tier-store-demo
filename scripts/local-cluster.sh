#!/usr/bin/env bash
# Clúster K3s en UNA sola computadora con k3d: cada nodo K3s es un contenedor Docker.
# Por defecto reproduce la topología del equipo: 1 server + 1 agent.
#
#   scripts/local-cluster.sh up        crea el clúster y despliega todo con kubectl, en el
#                                      orden de clusters/dev (sin GitHub; imágenes locales)
#   scripts/local-cluster.sh gitops    crea el clúster y deja que Flux lo despliegue desde
#                                      GitHub (Fase 5 real: SOPS, dependsOn, drift, rollback)
#   scripts/local-cluster.sh images    reconstruye e importa las imágenes :local
#   scripts/local-cluster.sh status    estado de nodos, HelmReleases y pods
#   scripts/local-cluster.sh down      borra el clúster
#
# Variables:
#   SERVERS=1 AGENTS=1   topología (SERVERS=3 AGENTS=0 para HA del plano de control; ~2 GB más)
#   LITE=1               (por defecto) omite Kyverno y KEDA para ahorrar ~0.7 GB; LITE=0 los instala
#   CHAOS=1              (por defecto) instala Chaos Mesh para las pruebas de resiliencia
#   OBSERVABILITY=0      (por defecto) sin OTel + otel-lgtm (opcional, ~1-2 GB)
#   REPO_URL             solo para "gitops": URL https del repositorio público en GitHub
#   K3S_IMAGE, CLUSTER_NAME
# Requisitos: docker, k3d >= 5.6, kubectl, flux CLI >= 2.4, openssl (y age.key para gitops).
# RAM: ~5.5 GB de WSL con los valores por defecto (memory=6GB en .wslconfig).
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER_NAME=${CLUSTER_NAME:-store}
K3S_IMAGE=${K3S_IMAGE:-rancher/k3s:v1.33.5-k3s1}
SERVERS=${SERVERS:-1}
AGENTS=${AGENTS:-1}
LITE=${LITE:-1}
CHAOS=${CHAOS:-1}
OBSERVABILITY=${OBSERVABILITY:-0}
CTX=k3d-$CLUSTER_NAME
K="kubectl --context $CTX"

need() { command -v "$1" >/dev/null || { echo "Falta '$1' en el PATH." >&2; exit 1; }; }

wait_for() { # kind name namespace timeout
  echo "   esperando $1/$2 ($3)..."
  $K -n "$3" wait --for=condition=Ready "$1/$2" --timeout="$4"
}

create_cluster() {
  if k3d cluster list "$CLUSTER_NAME" >/dev/null 2>&1; then
    echo "El clúster $CLUSTER_NAME ya existe; se reutiliza."
  else
    echo "Creando clúster k3d: $SERVERS server(s) + $AGENTS agent(s) ($K3S_IMAGE)"
    k3d cluster create "$CLUSTER_NAME" --servers "$SERVERS" --agents "$AGENTS" --image "$K3S_IMAGE" \
      -p "8080:80@loadbalancer" -p "8443:443@loadbalancer" \
      --k3s-arg "--secrets-encryption@server:*" --wait
  fi
  # Nombres de nodo parecidos al clúster del equipo, para que las pruebas se lean igual.
  $K get nodes -o wide
}

optional_releases() {
  # Quita lo opcional para ahorrar memoria (después de aplicar los operadores).
  local drop=()
  [ "$LITE" = "1" ] && drop+=(kyverno keda)
  [ "$CHAOS" = "1" ] || drop+=(chaos-mesh)
  if [ ${#drop[@]} -gt 0 ]; then
    $K -n flux-system delete helmrelease "${drop[@]}" --ignore-not-found
  fi
}

build_images() {
  need docker
  docker build -f application/Dockerfile -t ghcr.io/carlosdanielqueperez/store-api:local .
  docker build -f worker/Dockerfile -t ghcr.io/carlosdanielqueperez/store-worker:local .
  docker build -f web/Dockerfile -t ghcr.io/carlosdanielqueperez/store-web:local .
  k3d image import -c "$CLUSTER_NAME" \
    ghcr.io/carlosdanielqueperez/store-api:local \
    ghcr.io/carlosdanielqueperez/store-worker:local \
    ghcr.io/carlosdanielqueperez/store-web:local
}

up() {
  need k3d; need kubectl; need flux; need openssl
  echo "[1/9] Clúster"
  create_cluster

  echo "[2/9] Imágenes de la tienda (:local)"
  build_images

  echo "[3/9] Controladores de Flux (sin conexión a Git)"
  flux --context "$CTX" install --components=source-controller,kustomize-controller,helm-controller,notification-controller

  echo "[4/9] Fuentes Helm y operadores"
  $K apply -k deploy/platform/sources
  $K apply -k deploy/local/operators
  optional_releases
  for hr in mariadb-operator-crds mariadb-operator mongodb-community-operator redis-operator cert-manager; do
    wait_for helmrelease "$hr" flux-system 15m
  done
  $K -n rabbitmq-system rollout status deploy/rabbitmq-cluster-operator --timeout=10m

  echo "[5/9] Configuración de plataforma (cert-manager, Traefik y, sin LITE, Kyverno)"
  if [ "$LITE" = "1" ]; then
    $K apply -k deploy/local/config-lite
  else
    wait_for helmrelease kyverno flux-system 10m
    $K apply -k deploy/local/config
  fi

  echo "[6/9] Secrets (contraseñas aleatorias; en GitOps van cifrados con SOPS)"
  if ! $K -n store get secret store-app-secrets >/dev/null 2>&1; then
    KUBECTL_CONTEXT=$CTX scripts/generate-secrets.sh dev --apply
  fi

  echo "[7/9] Capa de datos (Galera + MaxScale, MongoDB, Redis + Sentinel) y RabbitMQ"
  $K apply -k deploy/data
  $K apply -k deploy/queues
  wait_for mariadb store-mariadb store-data 20m
  $K -n store-data wait --for=jsonpath='{.status.phase}'=Running mongodbcommunity/store-mongodb --timeout=20m
  $K -n store-data rollout status statefulset/store-rabbitmq-server --timeout=15m
  $K -n store-data rollout status statefulset/store-redis --timeout=10m

  if [ "$OBSERVABILITY" = "1" ]; then
    echo "[8/9] Observabilidad (OTel Collector + otel-lgtm)"
    $K apply -k deploy/platform/observability/dev
  else
    echo "[8/9] Observabilidad omitida (opcional, ~1-2 GB de RAM). Para incluirla: OBSERVABILITY=1"
  fi

  echo "[9/9] Aplicación (web, API, worker, migraciones)"
  $K -n store delete job store-init --ignore-not-found
  $K apply -k deploy/local/apps
  $K -n store wait --for=condition=complete job/store-init --timeout=10m
  $K -n store rollout status deploy/store-api --timeout=5m
  $K -n store rollout status deploy/store-web --timeout=5m
  $K -n store rollout status deploy/store-worker --timeout=5m
  done_message
}

# Flux real desde GitHub sobre el clúster local. Requisitos:
#  - el repositorio subido a GitHub y público (o REPO_URL con credenciales de lectura),
#  - deploy/secrets/dev/store-secrets.sops.yaml cifrado y subido, y age.key en la raíz,
#  - las imágenes publicadas en GHCR por release.yml y marcadas como públicas.
gitops() {
  need k3d; need kubectl; need flux
  local repo=${REPO_URL:-}
  [ -n "$repo" ] || { echo "Define REPO_URL, p. ej. REPO_URL=https://github.com/<usuario>/Distributed-three-tier-store-demo" >&2; exit 1; }
  [ -f age.key ] || { echo "Falta age.key en la raíz del repositorio (ver docs/CLUSTER-EQUIPO.md, paso 4)." >&2; exit 1; }

  echo "[1/5] Clúster"
  create_cluster

  echo "[2/5] Flux"
  flux --context "$CTX" install
  $K -n flux-system create secret generic sops-age --from-file=age.agekey=age.key --dry-run=client -o yaml | $K apply -f -

  echo "[3/5] Fuente Git: $repo (rama main)"
  flux --context "$CTX" create source git flux-system --url="$repo" --branch=main --interval=1m

  echo "[4/5] Kustomizations de clusters/dev (sources → operators → config → secrets → data → queues → apps)"
  $K apply -f clusters/dev/infrastructure.yaml -f clusters/dev/apps.yaml
  # Perfil de baja memoria: se agregan patches de borrado a las Kustomizations aplicadas.
  local ops=()
  [ "$LITE" = "1" ] && ops+=(kyverno keda)
  [ "$CHAOS" = "1" ] || ops+=(chaos-mesh)
  for hr in "${ops[@]}"; do
    $K -n flux-system patch kustomization platform-operators --type=json -p "[{\"op\":\"add\",\"path\":\"/spec/patches/-\",\"value\":{\"patch\":\"\$patch: delete\napiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nmetadata: {name: $hr, namespace: flux-system}\n\"}}]"
  done
  if [ "$LITE" = "1" ]; then
    for pol in verify-store-images store-workload-hygiene; do
      $K -n flux-system patch kustomization platform-config --type=json -p "[{\"op\":\"add\",\"path\":\"/spec/patches/-\",\"value\":{\"patch\":\"\$patch: delete\napiVersion: kyverno.io/v1\nkind: ClusterPolicy\nmetadata: {name: $pol}\n\"}}]"
    done
  fi
  if [ "$OBSERVABILITY" = "1" ]; then
    flux --context "$CTX" resume kustomization observability
  fi

  echo "[5/5] Esperando a que Flux reconcilie todo (20-40 min la primera vez)"
  flux --context "$CTX" get kustomizations
  $K -n flux-system wait --for=condition=Ready kustomization/apps --timeout=60m
  flux --context "$CTX" get kustomizations
  done_message
}

done_message() {
  echo
  echo "Listo. Agrega al archivo hosts de Windows:  127.0.0.1 store.local grafana.store.local"
  echo "  Tienda:  http://store.local:8080/      (o https://store.local:8443/ con la CA de cert-manager)"
  if [ "$OBSERVABILITY" = "1" ]; then echo "  Grafana: http://grafana.store.local:8080/  (admin/admin)"; fi
  echo "  Pruebas: pruebas/plataforma/run-perf.sh   y   pruebas/plataforma/run-chaos.sh"
}

status() {
  $K get nodes -o wide
  $K -n flux-system get helmreleases,kustomizations 2>/dev/null || true
  $K -n store-data get pods -o wide
  $K -n store get pods -o wide
  docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}' | grep -E "NAME|k3d-$CLUSTER_NAME" || true
}

case "${1:-up}" in
  up) up ;;
  gitops) gitops ;;
  images) build_images; $K -n store rollout restart deploy/store-api deploy/store-web deploy/store-worker ;;
  status) status ;;
  down) k3d cluster delete "$CLUSTER_NAME" ;;
  *) echo "Uso: $0 {up|gitops|images|status|down}" >&2; exit 1 ;;
esac
