# Pruebas: cómo ejecutarlas y dónde registrar los resultados

Hay tres niveles: pruebas unitarias (sin infraestructura), la pila de Docker Compose
(línea base y comparación con `pruebas/antes` y `pruebas/despues`) y la plataforma K3s
(desempeño y resiliencia). Los resultados de K3s se guardan solos en
`pruebas/plataforma/<fecha>/resumen.txt`; cópialos en la [tabla final](#5-resultados).

## 0. Requisitos

| Herramienta | Para qué | Versión probada |
|-------------|----------|-----------------|
| Node.js | pruebas unitarias y lint | 22 |
| Docker (en WSL: activar la integración de Docker Desktop con la distro) | Compose, imágenes, k3d | 27+ |
| k3d, kubectl, flux CLI | clúster en una sola computadora (1 server + 1 agent) | k3d 5.6+, flux 2.4+ |
| terraform u OpenTofu, sops, age | clúster real en las computadoras del equipo | 1.10+ |

> **Memoria en WSL**: con los valores por defecto del script (1 server + 1 agent, sin
> observabilidad, sin Kyverno ni KEDA) el clúster usa ≈5.5 GB. En `%UserProfile%\.wslconfig`
> pon `[wsl2]`, `memory=6GB` y `swap=4GB`, y luego ejecuta `wsl --shutdown`. En el clúster real del equipo (2 computadoras) cada una necesita ≈5 GB para WSL.

## 1. Pruebas unitarias y lint (sin Docker)

```bash
npm ci && (cd application && npm ci) && (cd worker && npm ci)
```

```bash
npm run lint
```

```bash
npm test
```

Resultado esperado: `# pass 34`, `# fail 0`. Cubren la API (sondas, caché, estampida,
cola, idempotencia, autenticación), el worker (reintentos 1s/5s/30s → DLQ, duplicados,
invalidación, refresh), las migraciones y la topología de RabbitMQ.

## 2. Docker Compose (entorno local y línea base)

```bash
./levantar.sh
```

`levantar.sh` crea `.env` o le agrega las variables nuevas que falten. Para incluir trazas
y Grafana en `http://localhost:3000`, pon `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318`
en `.env` y levanta el perfil:

```bash
docker compose --profile observability up -d --build
```

Pruebas funcionales rápidas:

```bash
curl -s http://localhost/api/readyz
```

```bash
curl -si -X POST http://localhost/api/products/ST-001/reviews -H 'content-type: application/json' -H 'idempotency-key: demo-review-0001' -d '{"reviewer":"Taylor","rating":5,"comment":"Great bag."}'
```

Debe responder `202 Accepted`; un segundo después la reseña aparece en
`curl -s http://localhost/api/products/ST-001/reviews`. Repite el mismo comando: sigue
habiendo una sola reseña con esa llave (idempotencia).

```bash
curl -si -X PUT http://localhost/api/products/ST-002/price -H "authorization: Bearer $(grep ^API_ADMIN_TOKEN= .env | cut -d= -f2)" -H 'content-type: application/json' -d '{"price":4.10}'
```

Reintentos y DLQ: pon `WORKER_FAILURE_RATE=1` en `.env`, ejecuta
`docker compose up -d worker`, envía una reseña y mira `reviews.retry.*` y luego
`reviews.dlq` en la consola de RabbitMQ (`http://localhost:15672`). Regrésalo a `0` al
terminar.

Línea base de desempeño en Compose, con la misma carga que se usará en K3s:

```bash
pruebas/plataforma/run-perf.sh compose
```

El dashboard de `resilience-lab` sigue funcionando igual (`/api/health` es alias de
`/readyz`).

## 3. Plataforma K3s en una sola computadora (k3d: 1 server + 1 agent)

Cada nodo K3s es un contenedor Docker. Hay dos formas de desplegarlo:

```bash
scripts/local-cluster.sh up
```

`up` despliega con kubectl e imágenes construidas en tu computadora; no necesita GitHub.
La otra forma es **Flux real desde GitHub** (Fase 5). Necesita el repositorio subido,
`age.key` y las imágenes de GHCR públicas:

```bash
REPO_URL=https://github.com/<usuario>/Distributed-three-tier-store-demo scripts/local-cluster.sh gitops
```

Opciones: `OBSERVABILITY=1` (Grafana, +1–2 GB), `LITE=0` (Kyverno y KEDA, +0.7 GB),
`CHAOS=0` (sin Chaos Mesh) y `SERVERS=3 AGENTS=0` (plano de control en HA, +2 GB). Al terminar, agrega
`127.0.0.1 store.local grafana.store.local` al archivo hosts (en Windows:
`C:\Windows\System32\drivers\etc\hosts`).

```bash
scripts/local-cluster.sh status
```

Pruebas de desempeño (genera `pruebas/plataforma/<fecha>/`):

```bash
pruebas/plataforma/run-perf.sh
```

Para una versión corta de unos 2 minutos, usa en su lugar
`REQUESTS=5000 CONCURRENCY=20 pruebas/plataforma/run-perf.sh`.

Escenarios que mide `run-perf.sh`:

| # | Escenario | Qué demuestra |
|---|-----------|---------------|
| 1 | `GET /` vía `store-web` | capacidad de Nginx |
| 2 | `GET /api/products/cheapest` vía web | mismo escenario que `pruebas/despues` (comparable) |
| 3 | `GET /products/cheapest` directo a la API | costo del salto de Nginx |
| 4 | `POST` de reseñas | aceptación asíncrona (202) y tiempo en que el worker **drena** la cola |
| 5 | Ingress con `Host: store.local` | el `rate-limit` de Traefik produce 429 por encima de 100 req/s por IP |

Resiliencia bajo carga (Chaos Mesh, `LITE=0`):

```bash
pruebas/plataforma/run-chaos.sh all
```

Para un solo experimento: `pruebas/plataforma/run-chaos.sh galera-pod-kill`. La guía de
pérdida de nodo se imprime con `pruebas/plataforma/run-chaos.sh node-loss`. En k3d, un
nodo se apaga con `docker stop k3d-store-agent-0` y se regresa con `docker start k3d-store-agent-0`.

Observabilidad (**opcional**, consume 1–2 GB de RAM): solo si levantaste el clúster con
`OBSERVABILITY=1 scripts/local-cluster.sh up`. Abre `http://grafana.store.local:8080` (admin/admin), dashboard
**"Tienda distribuida — RED, caché, colas y datos"**. En la tienda, el *trace ID* de cada
petición abre la traza en Tempo: navegador → Nginx → API → Redis/MariaDB/RabbitMQ →
worker → MongoDB.

Seguridad (opcional):

```bash
kubectl apply -f deploy/platform/security/kube-bench-job.yaml
```

```bash
kubectl -n kube-system logs job/kube-bench > pruebas/plataforma/kube-bench.txt
```

Wazuh necesita ≈4 GB adicionales: `deploy/platform/wazuh/bootstrap.sh`.

```bash
scripts/local-cluster.sh down
```

## 4. Clúster real: un nodo en cada computadora (equipo de 2)

| Computadora | `role` en `terraform.tfvars` | Qué ejecuta |
|-------------|------------------------------|-------------|
| 1 | `server` | plano de control (etcd) + cargas, y desde aquí se corre Terraform, kubectl y las pruebas |
| 2 | `agent` | cargas |

Con Windows + WSL (nuestro caso: una computadora con Windows 10), los nodos se unen por
**Tailscale**. La guía completa, paso a paso, está en [CLUSTER-EQUIPO.md](CLUSTER-EQUIPO.md).
Los pasos de abajo son el resumen para nodos con Linux en la misma LAN.

1. En cada computadora (Ubuntu 22.04/24.04): usuario con `sudo` sin contraseña y tu llave
   SSH en `~/.ssh/authorized_keys`. Las dos en la misma LAN.
2. `age-keygen -o age.key` y pon la llave pública en `.sops.yaml`.
3. `scripts/generate-secrets.sh dev` (crea `deploy/secrets/dev/store-secrets.sops.yaml` cifrado).
4. Sube los cambios a tu repositorio (Flux lee desde GitHub).
5. En `infra/terraform/envs/dev`: copia `terraform.tfvars.example` → `terraform.tfvars`
   (IPs reales) y `backend.hcl.example` → `backend.hcl`.

```bash
cd infra/terraform/envs/dev && terraform init -backend-config=backend.hcl
```

```bash
terraform apply -target=module.k3s
```

```bash
GITHUB_TOKEN=<token con permiso de admin del repo> terraform apply
```

```bash
flux --kubeconfig kubeconfig-dev.yaml get kustomizations --watch
```

Cuando `apps` esté `Ready`, ejecuta las pruebas de la sección 3 con
`KUBE_CONTEXT=default KUBECONFIG=infra/terraform/envs/dev/kubeconfig-dev.yaml`.

## 5. Resultados

Ejecutadas el **2026-11-24** en una sola computadora (Windows + WSL 2, 6 GB para WSL,
12 hilos), porque la segunda computadora del equipo se descompuso. Docker Compose usa la
pila completa (34 contenedores). K3s corre en k3d con **1 server + 1 agent**, con
2 API, 2 web y 1–2 workers, y sin observabilidad ni Kyverno/KEDA por memoria. La carga se
genera con ApacheBench (`ab`): en Compose desde un contenedor en la red `edge`; en K3s
desde un pod dentro del clúster. Capturas y salidas completas en
[evidencias/](evidencias/README.md); datos crudos en `pruebas/plataforma/`.

Referencia anterior del repositorio: `pruebas/despues/resumen.txt` (Compose con galera1
caído: 20 148 peticiones, 20 fallidas, **498.91 req/s**).

### Desempeño

| Escenario | Entorno | n / c | req/s | p50 ms | p95 ms | p99 ms | Fallidas / no-2xx |
|-----------|---------|-------|-------|--------|--------|--------|--------------------|
| GET /api/products/cheapest | Compose | 20000 / 50 | 917.4 | 48 | 110 | 165 | 0 / 0 |
| GET /api/products/cheapest (vía web) | K3s | 20000 / 50 | **953.1** | 35 | 126 | 531 | 0 / 0 |
| GET /products/cheapest (API directa) | K3s | 20000 / 50 | 927.5 | 31 | 158 | 276 | 0 / 0 |
| GET / (Nginx) | K3s | 20000 / 50 | 863.9 | 27 | 120 | 296 | 0 / 0 |
| POST reseñas (202, cola) | Compose | 5000 / 50 | 321.0 | 141 | 271 | 349 | 0 / 0 |
| POST reseñas (202, cola) | K3s | 5000 / 50 | 241.9 | 165 | 485 | 830 | 0 / 0 |
| Drenado de la cola reviews.created | K3s | 5000 msgs | — | — | — | — | pico 2 267 mensajes, vacía en **35 s**, DLQ: 0 |
| Ingress con rate limit (100 req/s por IP) | K3s | 3000 / 50 | 768.0 | 40 | 146 | 409 | 429: **2 453** (esperado) |

En los dos entornos, las 5 000 reseñas quedaron guardadas en MongoDB (`countDocuments`
= 5000) sin mensajes en la DLQ.

**Lectura de los resultados**
- El catálogo en K3s (953 req/s) iguala o supera a Compose (917 req/s) con menos réplicas
  (2 API frente a 3), y ambos casi duplican la referencia anterior (499 req/s). El p99 es
  mayor en K3s porque los dos nodos y el generador de carga comparten la misma CPU.
- En las escrituras, la API solo valida y publica (202). La cola absorbe la ráfaga (hasta
  2 267 mensajes) y el worker la drena en 35 s sin perder mensajes.
- El rate limit de Traefik funciona: por encima de 100 req/s desde una misma IP responde 429.

### Resiliencia (carga continua con ab durante el experimento)

Cada experimento de Chaos Mesh se aplicó a los 20 s de una carga de 90 s
(`ab -c 20` contra `/api/products/cheapest`).

| Experimento | Peticiones | Fallidas | No-2xx | Disponibilidad | Observaciones |
|-------------|-----------|----------|--------|----------------|---------------|
| api-pod-kill | 58 861 | 0 | 0 | **100 %** | p95 72 ms |
| web-pod-kill | 38 860 | 0 | 0 | **100 %** | p95 80 ms |
| galera-pod-kill | 27 741 | 0 | 0 | **100 %** | MaxScale enruta a los nodos restantes; p99 815 ms |
| mongodb-pod-kill | 64 968 | 0 | 0 | **100 %** | el replica set elige otro primario |
| redis-pod-kill | 34 350 | 0 | 0 | **100 %** | Sentinel promueve una réplica |
| rabbitmq-pod-kill | 43 525 | 0 | 0 | **100 %** | colas quorum con 2 de 3 nodos |
| worker-pod-failure (60 s) | 40 910 | 0 | 0 | **100 %** | las lecturas no dependen del worker |
| api-network-delay (200 ms) | 17 793 | 0 | 0 | **100 %** | p95 sube a 305 ms (> SLO de 300 ms): la alerta de latencia se dispararía |
| pérdida del nodo agent (2 min 47 s) | — | — | — | **0 % durante la caída** | ver abajo |
| pérdida del nodo server | — | — | — | no ejecutada | apagaría el plano de control; ver limitaciones |

**Pérdida del nodo agent** (`pruebas/plataforma/run-node-loss-k3d.sh`). Se apagó el
contenedor del nodo agent a las 17:54:41, simulando que se descompone la segunda
computadora. A los 8 s la tienda dejó de responder y siguió así hasta el final de la
medición (17:58:20), incluso 30 s después de que el nodo volviera a `Ready` (en 21 s).
La causa son las réplicas que quedaron en el nodo apagado:
- MongoDB tenía 2 de sus 3 miembros en el agent: el que queda no tiene mayoría, así que
  no hay primario.
- 2 de los 3 Sentinels de Redis estaban en el agent: no hay quórum para promover un maestro.
  Al volver el nodo, Redis quedó con dos maestros y hubo que repararlo a mano
  ([runbook](runbooks/node-loss.md#redis-con-dos-maestros-tras-recuperar-el-nodo-clúster-de-2-nodos)).
- Galera (2 de 3 en el server) y RabbitMQ (2 de 3 en el server) sí conservaron la mayoría.

Conclusión: **con 2 nodos el sistema tolera la caída de pods y de réplicas individuales
(100 % de disponibilidad en los 8 experimentos), pero no la de un nodo completo**: con 3
réplicas en 2 nodos, uno de ellos siempre aloja la mayoría de algún servicio de datos.
Tolerar la pérdida de cualquier nodo requiere 3 nodos con una réplica en cada uno, que es
lo que pide el plan y lo que el código ya soporta (`SERVERS=3` en k3d o `role = "server"`
en tres computadoras).

Además, esta prueba encontró y corrigió un error real: el Secret con la cadena de
conexión de MongoDB, publicado en otro namespace, era borrado en bucle por Kubernetes (ver
[IMPLEMENTACION.md](IMPLEMENTACION.md), Fase 2).
