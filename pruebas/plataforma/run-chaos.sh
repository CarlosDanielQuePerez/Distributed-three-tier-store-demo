#!/usr/bin/env bash
# Resiliencia bajo carga (Fase 8): port de los escenarios de resilience-lab a Kubernetes.
# Lanza ab durante DURATION segundos y a los 20 s aplica un experimento de Chaos Mesh.
#
#   pruebas/plataforma/run-chaos.sh api-pod-kill
#   pruebas/plataforma/run-chaos.sh galera-pod-kill
#   pruebas/plataforma/run-chaos.sh all            todos los experimentos, uno tras otro
#   pruebas/plataforma/run-chaos.sh node-loss      guía para apagar un nodo (manual)
#
# Experimentos: deploy/platform/chaos/experiments/*.yaml
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

DURATION=${DURATION:-90}
CONCURRENCY=${CONCURRENCY:-20}
EXP_DIR=../../deploy/platform/chaos/experiments
URL=${URL:-http://store-web.store.svc.cluster.local/api/products/cheapest}
OUT=chaos-$(date +%Y%m%d-%H%M%S)

run_one() {
  local name=$1 file="$EXP_DIR/$1.yaml"
  [ -f "$file" ] || { echo "No existe $file" >&2; exit 1; }
  echo "== $name"
  ab_run "$OUT/$name.txt" -t "$DURATION" -n 10000000 -c "$CONCURRENCY" -s 10 "$URL" &
  local ab_pid=$!
  sleep 20
  $K apply -f "$file"
  $K -n store-data get pods -o wide > "$OUT/$name.pods-during.txt" 2>&1 || true
  $K -n store get pods -o wide >> "$OUT/$name.pods-during.txt" 2>&1 || true
  wait "$ab_pid" || true
  $K delete -f "$file" --ignore-not-found >/dev/null
  summarize "$OUT/$name.txt" "$name" | tee -a "$OUT/resumen.txt"
}

case "${1:-}" in
  node-loss)
    cat <<'TXT'
Pérdida de nodo (equipo de 2 computadoras: 1 server + 1 agent):
  1. En otra terminal:  DURATION=180 pruebas/plataforma/run-chaos.sh baseline
  2. Apaga K3s en la computadora AGENT:  sudo systemctl stop k3s-agent
     Observa: kubectl get nodes -w ; los pods se reprograman en el server tras ~5 min.
     Mongo elige primario, Redis Sentinel promueve réplica. Galera y RabbitMQ siguen
     si conservan 2 de 3 réplicas (revisa en qué nodo estaban: kubectl -n store-data get pods -o wide).
  3. sudo systemctl start k3s-agent  y verifica que el nodo vuelve a Ready.
  4. (Opcional) Repite con el SERVER (sudo systemctl stop k3s): el plano de control se
     detiene; mide qué siguió respondiendo con la carga de ab y anótalo como limitación.
En k3d (una sola computadora):  docker stop k3d-store-agent-0   …   docker start k3d-store-agent-0
TXT
    ;;
  baseline)
    ensure_loadgen; mkdir -p "$OUT"
    ab_run "$OUT/baseline.txt" -t "$DURATION" -n 10000000 -c "$CONCURRENCY" -s 10 "$URL"
    summarize "$OUT/baseline.txt" baseline | tee -a "$OUT/resumen.txt"
    ;;
  all)
    ensure_loadgen; mkdir -p "$OUT"
    for f in "$EXP_DIR"/*.yaml; do run_one "$(basename "$f" .yaml)"; sleep 30; done
    ;;
  "")
    echo "Uso: $0 <experimento|all|baseline|node-loss>"; ls "$EXP_DIR" | sed 's/.yaml$//; s/^/  /'
    ;;
  *)
    ensure_loadgen; mkdir -p "$OUT"; run_one "$1"
    ;;
esac
