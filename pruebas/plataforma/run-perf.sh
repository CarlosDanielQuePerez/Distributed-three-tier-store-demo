#!/usr/bin/env bash
# Pruebas de desempeño de la plataforma K3s (Fase 8). Guarda todo en
# pruebas/plataforma/<fecha>/ y un resumen.txt comparable con pruebas/despues/.
#
#   pruebas/plataforma/run-perf.sh                 escenarios completos (≈10 min)
#   REQUESTS=5000 CONCURRENCY=20 pruebas/plataforma/run-perf.sh   versión corta
#   pruebas/plataforma/run-perf.sh compose         mismo escenario contra Docker Compose
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

REQUESTS=${REQUESTS:-20000}
CONCURRENCY=${CONCURRENCY:-50}
REVIEWS=${REVIEWS:-5000}
OUT=$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
printf '{"reviewer":"loadtest","rating":5,"comment":"Prueba de carga de la cola"}' > "$OUT/review.json"

if [ "${1:-k3s}" = "compose" ]; then
  # Línea base: la pila de Docker Compose (HAProxy + Keepalived) con la misma carga.
  NET=${COMPOSE_NETWORK:-distributed-three-tier_edge}
  run() { docker run --rm --network "$NET" -v "$PWD/$OUT:/out" httpd:2.4.62-alpine ab -r -l "$@"; }
  run -n "$REQUESTS" -c "$CONCURRENCY" http://presentation-entry/api/products/cheapest > "$OUT/compose_cheapest.txt" 2>&1 || true
  run -n "$REVIEWS" -c "$CONCURRENCY" -p /out/review.json -T application/json http://presentation-entry/api/products/ST-001/reviews > "$OUT/compose_reviews.txt" 2>&1 || true
  {
    echo "Docker Compose — $(date -Iseconds)  n=$REQUESTS c=$CONCURRENCY"
    summarize "$OUT/compose_cheapest.txt" "GET /api/products/cheapest"
    summarize "$OUT/compose_reviews.txt" "POST reseñas (cola)"
  } | tee "$OUT/resumen.txt"
  exit 0
fi

ensure_loadgen
WEB=http://store-web.store.svc.cluster.local
API=http://store-api.store.svc.cluster.local:8080
INGRESS=http://traefik.kube-system.svc.cluster.local

{
  echo "Plataforma K3s — $(date -Iseconds)  contexto=$KCTX  n=$REQUESTS c=$CONCURRENCY"
  $K get nodes --no-headers | awk '{print "  nodo " $1 " " $2 " " $5}'
  $K -n store get deploy --no-headers | awk '{print "  deploy " $1 " " $2}'
} > "$OUT/entorno.txt"

echo "[1/6] Calentamiento"
ab_run "$OUT/00_warmup.txt" -n 500 -c 10 "$WEB/api/products/cheapest" >/dev/null

echo "[2/6] Página estática (Nginx)"
ab_run "$OUT/01_web_index.txt" -n "$REQUESTS" -c "$CONCURRENCY" "$WEB/"

echo "[3/6] Catálogo a través de web → API → Redis (comparable con pruebas/despues)"
ab_run "$OUT/02_web_cheapest.txt" -n "$REQUESTS" -c "$CONCURRENCY" "$WEB/api/products/cheapest"

echo "[4/6] Catálogo directo a la API (sin Nginx)"
ab_run "$OUT/03_api_cheapest.txt" -n "$REQUESTS" -c "$CONCURRENCY" "$API/products/cheapest"

echo "[5/6] Escrituras asíncronas: POST reseñas → RabbitMQ → worker → MongoDB"
before=$(queue_depth reviews.created || echo "?")
start=$(date +%s)
# ab necesita el cuerpo dentro del pod. Se pasa como argumento (no por stdin: "kubectl
# exec -i" puede cerrar la entrada antes de enviarla y dejar el archivo vacío) y se verifica.
$K -n store exec loadgen -- sh -c 'printf %s "$1" > /tmp/review.json' _ "$(cat "$OUT/review.json")"
[ "$($K -n store exec loadgen -- wc -c < /dev/null /tmp/review.json | awk '{print $1}')" -gt 0 ] || { echo "No se pudo copiar review.json al pod" >&2; exit 1; }
ab_run "$OUT/04_reviews_post.txt" -n "$REVIEWS" -c "$CONCURRENCY" -p /tmp/review.json -T application/json "$WEB/api/products/ST-001/reviews"
published=$(date +%s)
peak=$(queue_depth reviews.created || echo "?")
for _ in $(seq 1 120); do
  d=$(queue_depth reviews.created || echo 0)
  [ "${d:-0}" = "0" ] && break
  sleep 1
done
drained=$(date +%s)
echo "cola reviews.created: antes=$before al_terminar_ab=$peak drenada_en=$((drained - published))s total=$((drained - start))s dlq=$(queue_depth reviews.dlq || echo ?)" | tee "$OUT/04_reviews_queue.txt"

echo "[6/6] Ingress con límite de peticiones (Traefik rate-limit 100 req/s por IP)"
ab_run "$OUT/05_ingress_ratelimit.txt" -n 3000 -c 50 -H "Host: store.local" "$INGRESS/api/products/cheapest"

{
  cat "$OUT/entorno.txt"
  echo
  summarize "$OUT/01_web_index.txt" "GET / (Nginx)"
  summarize "$OUT/02_web_cheapest.txt" "GET /api/products/cheapest (web)"
  summarize "$OUT/03_api_cheapest.txt" "GET /products/cheapest (API)"
  summarize "$OUT/04_reviews_post.txt" "POST reseñas (202, cola)"
  cat "$OUT/04_reviews_queue.txt"
  summarize "$OUT/05_ingress_ratelimit.txt" "Ingress (no2xx = 429 rate limit)"
} | tee "$OUT/resumen.txt"
echo
echo "Resultados en pruebas/plataforma/$OUT/"
