#!/usr/bin/env bash
# Pérdida de nodo en el clúster k3d de una sola computadora (Fase 8).
# Apaga el contenedor del nodo agent durante la carga, como si se descompusiera la
# segunda computadora, y lo vuelve a encender antes de que Kubernetes desaloje sus pods
# (5 min), para no saturar la memoria del nodo server.
#
#   pruebas/plataforma/run-node-loss-k3d.sh
#
# Variables: KUBE_CONTEXT (k3d-store), NODE (k3d-store-agent-0), DOWN_AT (30 s),
#            DOWN_FOR (150 s), DURATION (240 s), CONCURRENCY (10).
set -euo pipefail
cd "$(dirname "$0")"
export KUBE_CONTEXT=${KUBE_CONTEXT:-k3d-store}
source ./lib.sh

NODE=${NODE:-k3d-store-agent-0}
DOWN_AT=${DOWN_AT:-30}
DOWN_FOR=${DOWN_FOR:-150}
DURATION=${DURATION:-240}
CONCURRENCY=${CONCURRENCY:-10}
OUT=node-loss-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
WEB=http://store-web.store.svc.cluster.local

# Generador de carga fijado al nodo server (el del agent se apagaría con él).
SERVER=$($K get nodes -l node-role.kubernetes.io/control-plane -o jsonpath='{.items[0].metadata.name}')
sed -e "s/name: loadgen$/name: loadgen-server/" -e "s/^spec:$/spec:\n  nodeName: $SERVER/" loadgen.yaml | $K apply -f - >/dev/null
$K -n store wait --for=condition=Ready pod/loadgen-server --timeout=120s >/dev/null

snapshot() { # etiqueta
  {
    echo "### $1 ($(date +%T))"
    $K get nodes --no-headers 2>&1 | awk '{print "  " $1, $2}'
    $K -n store-data get pods --no-headers -o custom-columns=P:.metadata.name,R:.status.containerStatuses[0].ready,N:.spec.nodeName 2>&1 | sed 's/^/  /'
  } >> "$OUT/estado.txt"
}

# Sonda: código HTTP de cada endpoint cada segundo. Corre DENTRO del pod en un solo
# proceso: un "kubectl exec" por petición se queda colgado mientras el nodo está caído.
# Código 0 = sin respuesta en 3 s.
probe() {
  $K -n store exec loadgen-server -- sh -c '
    end=$(( $(date +%s) + '"$DURATION"' ))
    while [ "$(date +%s)" -lt "$end" ]; do
      for p in products/cheapest products/ST-001/reviews readyz; do
        c=$(wget -q -T 3 -O /dev/null -S "'"$WEB"'/api/$p" 2>&1 | awk "/HTTP\\//{c=\$2} END{print c+0}")
        echo "$(date +%T) $p $c"
      done
      sleep 1
    done' > "$OUT/sonda.txt" 2>&1
}

echo "Carga: ab -t $DURATION -c $CONCURRENCY contra /api/products/cheapest desde $SERVER"
snapshot "antes"
# -s 60: ab aborta toda la prueba si UNA petición supera el timeout de socket.
$K -n store exec loadgen-server -- ab -r -l -s 60 -t "$DURATION" -n 100000000 -c "$CONCURRENCY" \
  "$WEB/api/products/cheapest" > "$OUT/ab.txt" 2>&1 &
AB=$!
probe & PROBE=$!

sleep "$DOWN_AT"
echo "$(date +%T) docker stop $NODE" | tee -a "$OUT/eventos.txt"
docker stop "$NODE" >/dev/null
sleep 60; snapshot "nodo apagado +60s"
sleep $((DOWN_FOR - 60))
echo "$(date +%T) docker start $NODE" | tee -a "$OUT/eventos.txt"
docker start "$NODE" >/dev/null
start=$(date +%s)
until $K get node "$NODE" --no-headers 2>/dev/null | grep -q " Ready"; do sleep 3; done
echo "$(date +%T) $NODE Ready de nuevo en $(( $(date +%s) - start ))s" | tee -a "$OUT/eventos.txt"

wait "$AB" || true
wait "$PROBE" || true
sleep 30; snapshot "después (+30s de Ready)"

{
  summarize "$OUT/ab.txt" "GET /api/products/cheapest (ab)"
  echo "Sonda por endpoint (respuestas no-200 / total):"
  for path in products/cheapest products/ST-001/reviews readyz; do
    awk -v p="$path" '$2==p {t++; if ($3!=200) f++} END {printf "  %-24s %d / %d\n", p, f, t}' "$OUT/sonda.txt"
  done
  cat "$OUT/eventos.txt"
} | tee "$OUT/resumen.txt"
$K -n store delete pod loadgen-server --wait=false >/dev/null
echo "Resultados en pruebas/plataforma/$OUT/"
