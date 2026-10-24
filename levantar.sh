#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

# 1. Docker disponible
if ! docker info > /dev/null 2>&1; then
  echo "Docker no está corriendo. Abre Docker Desktop y vuelve a intentar."
  exit 1
fi

# 2. Crear .env con contraseñas aleatorias (solo si no existe)
if [ ! -f .env ]; then
  while IFS= read -r line; do
    if [[ "$line" =~ ^([A-Za-z0-9_]*(PASSWORD|PASS|SECRET)[A-Za-z0-9_]*)= ]]; then
      echo "${BASH_REMATCH[1]}=$(openssl rand -hex 12)"
    else
      echo "$line"
    fi
  done < .env.example > .env
  echo ".env creado"
else
  echo ".env ya existía, no se toca"
fi

# 3. Levantar todo (la primera vez tarda varios minutos)
docker compose up --build -d

# 4. Esperar a que la tienda responda (máximo 6 minutos)
echo "Esperando a que la tienda responda..."
ok=0
for i in $(seq 1 72); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/api/products/cheapest)
  if [ "$code" = "200" ]; then ok=1; echo "Tienda lista (intento $i)"; break; fi
  sleep 5
done
[ "$ok" = "1" ] || echo "La tienda no respondió a tiempo. Revisa con: docker compose ps"

# 5. Verificación
echo; echo "=== Contenedores que NO están Up ==="
docker compose ps -a --format "table {{.Service}}\t{{.Status}}" | grep -v " Up " || true

echo; echo "=== Galera ==="
set -a; source .env; set +a
docker compose exec -T galera1 mysql -uroot -p"$MARIADB_ROOT_PASSWORD" \
  -e "SHOW STATUS LIKE 'wsrep_cluster_size';" 2>/dev/null

echo; echo "Tienda:  http://localhost/"
echo "Nagios:  http://localhost:8088/  (usuario nagiosadmin)"
echo "Contraseña de Nagios: $NAGIOSADMIN_PASSWORD"
