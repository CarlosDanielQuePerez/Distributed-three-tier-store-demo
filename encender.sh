#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
unset GALERA1_BOOTSTRAP GALERA1_FORCE_BOOTSTRAP

if ! docker info >/dev/null 2>&1; then
  echo "Docker no está corriendo. Abre Docker Desktop, espera a que diga que está corriendo y vuelve a ejecutar."; exit 1
fi
[ -f .env ] || { echo "Falta el archivo .env en $(pwd)"; exit 1; }

v () { grep "^$1=" .env | cut -d= -f2-; }
set_var () { if grep -q "^$1=" .env; then sed -i "s/^$1=.*/$1=$2/" .env; else echo "$1=$2" >> .env; fi; }
size () { docker compose exec -T galera2 mysql -uroot -p"$(v MARIADB_ROOT_PASSWORD)" -e "SHOW STATUS LIKE 'wsrep_cluster_size';" </dev/null 2>/dev/null | awk 'NR==2{print $2}'; }

corriendo=$(docker compose ps --status running --format '{{.Service}}' | grep -cE '^galera[123]$')
USAR_BOOT=0
if [ "$corriendo" -gt 0 ]; then
  echo "[1/4] Galera ya tiene nodos encendidos: no toco el arranque del clúster, solo levanto lo que falte."
  docker compose up -d
else
  USAR_BOOT=1
  if docker volume inspect distributed-three-tier_galera1-data >/dev/null 2>&1; then
    S1=$(docker run --rm -v distributed-three-tier_galera1-data:/data alpine sh -c 'f=$(find /data -name grastate.dat | head -1); [ -n "$f" ] && grep safe_to_bootstrap "$f" | tr -d " "' 2>/dev/null)
  else
    S1="sin-volumen"
  fi
  echo "[1/4] Galera apagada por completo. Estado guardado de galera1: ${S1:-desconocido}"
  set_var GALERA1_BOOTSTRAP yes
  if [ "$S1" = "safe_to_bootstrap:0" ]; then
    echo "      Apagado no limpio: fuerzo el arranque de galera1 (válido aquí: los datos de Galera son solo el catálogo de ejemplo)."
    set_var GALERA1_FORCE_BOOTSTRAP yes
  else
    set_var GALERA1_FORCE_BOOTSTRAP no
  fi
  docker compose up -d --no-deps galera1
  ok=0
  for i in $(seq 1 40); do
    docker compose ps galera1 --format '{{.Status}}' | grep -q "(healthy)" && { ok=1; break; }
    sleep 5
  done
  if [ "$ok" != "1" ]; then echo "galera1 no quedó sano. Log:"; docker compose logs --tail=25 galera1; exit 1; fi
  echo "      galera1 sano. Levanto el resto..."
  docker compose up -d
fi

echo "[2/4] Esperando a que la tienda y Galera respondan (hasta 6 minutos)..."
for i in $(seq 1 72); do
  c=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://localhost/api/products/cheapest)
  [ "$c" = "200" ] && break; sleep 5
done
for i in $(seq 1 36); do [ "$(size)" = "3" ] && break; sleep 5; done

echo "[3/4] Recreando Keepalived y Nagios (evita fallos de 'already running' tras apagados)..."
docker compose up -d --force-recreate --no-deps presentation-keepalived-master presentation-keepalived-backup application-keepalived-master application-keepalived-backup nagios
sleep 20

if [ "$USAR_BOOT" = "1" ] || grep -q "^GALERA1_BOOTSTRAP=yes" .env || grep -q "^GALERA1_FORCE_BOOTSTRAP=yes" .env; then
  if [ "$(size)" = "3" ]; then
    echo "[4/4] Dejando galera1 en modo 'unirse' (para poder apagarlo y encenderlo solo)..."
    set_var GALERA1_BOOTSTRAP no
    set_var GALERA1_FORCE_BOOTSTRAP no
    docker compose up -d --no-deps galera1
    sleep 60
  else
    echo "[4/4] AVISO: Galera no tiene 3 nodos; dejo el arranque como está. Pégame esta salida."
  fi
else
  echo "[4/4] Nada que ajustar."
fi

echo; echo "================ RESUMEN ================"
fallas=0
ok () { echo "  [OK]    $1"; }
mal () { echo "  [FALLA] $1"; fallas=$((fallas+1)); }
c=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://localhost/api/products/cheapest)
[ "$c" = "200" ] && ok "Tienda responde" || mal "Tienda: HTTP $c"
n=$(size); [ "$n" = "3" ] && ok "Galera con 3 nodos" || mal "Galera con '$n' nodos"
for pair in "172.30.0.250:presentation" "172.31.0.250:application"; do
  ip="${pair%%:*}"; capa="${pair##*:}"; k=0
  for r in master backup; do docker compose exec -T "$capa-keepalived-$r" ip addr </dev/null 2>/dev/null | grep -q "$ip" && k=$((k+1)); done
  [ "$k" = "1" ] && ok "IP virtual $ip en un solo Keepalived" || mal "IP virtual $ip en $k Keepalived"
done
nc=000
for i in $(seq 1 12); do
  nc=$(curl -s -o /dev/null -m 5 -w "%{http_code}" -u "nagiosadmin:$(v NAGIOSADMIN_PASSWORD)" http://localhost:8088/nagios/)
  [ "$nc" = "200" ] && break; sleep 5
done
[ "$nc" = "200" ] && ok "Nagios responde" || mal "Nagios: HTTP $nc"
caidos=$(docker compose ps -a --format "{{.Service}} {{.Status}}" | grep -v " Up " | grep -vE "^(catalog-init|mongo-init) Exited \(0\)")
[ -z "$caidos" ] && ok "Todos los contenedores encendidos" || { mal "Contenedores caídos:"; echo "$caidos"; }
echo
[ "$fallas" = "0" ] && echo "TODO LISTO. Tienda: http://localhost/   Nagios: http://localhost:8088/nagios/" || echo "Hay $fallas problema(s). Pégame esta salida."
