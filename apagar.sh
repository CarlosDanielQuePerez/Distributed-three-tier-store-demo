#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if ! docker info >/dev/null 2>&1; then echo "Docker no está corriendo; no hay nada que apagar."; exit 0; fi

echo "Apagando Galera en orden (galera3 y galera2 primero)..."
docker compose stop galera3 galera2
echo "Apagando el resto (galera1 queda de último)..."
docker compose stop

echo; echo "=== Contenedores que siguen encendidos (debe salir vacío) ==="
docker compose ps --status running --format '{{.Service}}'
echo; echo "=== Estado guardado de Galera (galera1 debería decir safe_to_bootstrap:1) ==="
for n in 1 2 3; do
  vol="distributed-three-tier_galera${n}-data"
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    echo -n "galera$n: "
    docker run --rm -v "$vol":/data alpine sh -c 'grep safe_to_bootstrap $(find /data -name grastate.dat | head -1)' 2>/dev/null
  fi
done
echo; echo "Listo. Ya puedes cerrar Docker Desktop o apagar la computadora."
