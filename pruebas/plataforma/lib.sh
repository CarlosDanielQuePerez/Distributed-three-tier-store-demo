# Funciones comunes de las pruebas de la plataforma K3s.
KCTX=${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || true)}
K="kubectl --context $KCTX"

ensure_loadgen() {
  # Se recrea si no existe o si quedó terminado (p. ej. su nodo se apagó en una prueba).
  local phase
  phase=$($K -n store get pod loadgen -o jsonpath='{.status.phase}' 2>/dev/null || true)
  if [ -n "$phase" ] && [ "$phase" != "Running" ] && [ "$phase" != "Pending" ]; then
    $K -n store delete pod loadgen --wait=true >/dev/null
    phase=""
  fi
  if [ -z "$phase" ]; then
    $K apply -f "$(dirname "${BASH_SOURCE[0]}")/loadgen.yaml" >/dev/null
  fi
  $K -n store wait --for=condition=Ready pod/loadgen --timeout=120s >/dev/null
}

# ab_run <archivo-salida> <argumentos de ab...>
ab_run() {
  local out=$1; shift
  echo "+ ab $*" | tee "$out"
  $K -n store exec loadgen -- ab -r -l "$@" >>"$out" 2>&1 || true
}

# Resume una salida de ab en una línea: completadas, fallidas, no-2xx, req/s, p50, p95, p99, máx.
summarize() {
  local file=$1 label=$2
  awk -v label="$label" '
    /^Complete requests:/ {c=$3}
    /^Failed requests:/ {f=$3}
    /^Non-2xx responses:/ {n=$3}
    /^Requests per second:/ {r=$4}
    /^  50%/ {p50=$2} /^  95%/ {p95=$2} /^  99%/ {p99=$2} /^ 100%/ {mx=$2}
    END { printf "%-38s completadas=%-7s fallidas=%-5s no2xx=%-6s rps=%-9s p50=%sms p95=%sms p99=%sms max=%sms\n", label, c, f, (n==""?0:n), r, p50, p95, p99, mx }
  ' "$file"
}

queue_depth() { # nombre de cola
  $K -n store-data exec store-rabbitmq-server-0 -c rabbitmq -- rabbitmqctl -q list_queues name messages 2>/dev/null | awk -v q="$1" '$1==q {print $2}'
}
