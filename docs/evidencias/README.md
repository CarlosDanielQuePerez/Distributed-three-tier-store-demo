# Evidencias de ejecución (2026-11-24)

Capturas y salidas reales de la ejecución del proyecto, en el orden en que se hizo.
Entorno: una sola computadora con Windows + WSL 2 (Ubuntu 24.04, 6 GB para WSL,
12 hilos) y Docker Desktop. El clúster K3s corre en k3d con 1 server + 1 agent (plan B por
la falla de la segunda computadora; ver [CLUSTER-EQUIPO.md](../CLUSTER-EQUIPO.md)).
Las capturas de terminal se generaron con `scripts/capturar-evidencia.sh`, y las de la
tienda con Chrome en modo *headless*.

Los resultados resumidos y su análisis están en [PRUEBAS.md](../PRUEBAS.md#5-resultados).

## 1. Docker Compose (entorno de desarrollo y línea base)

| # | Evidencia | Qué muestra |
|---|-----------|-------------|
| 01 | [01-compose-contenedores.png](01-compose-contenedores.png) | Los 34 contenedores arriba, incluidos `rabbitmq` y los 2 `worker`, con Galera en `wsrep_cluster_size = 3`. Log completo: [01-levantar-compose.log](01-levantar-compose.log) |
| 01 | [01-tienda-compose.png](01-tienda-compose.png) | La tienda: *trace ID* W3C con enlace a Tempo, ruta de la petición, formulario de reseñas por la cola, precio actualizado por evento y la reseña guardada por el worker |
| 02 | [02-pruebas-funcionales-compose.png](02-pruebas-funcionales-compose.png) | `readyz` con las 4 dependencias; reseña aceptada con **202**; la misma `Idempotency-Key` no duplica; `PUT` de precio rechazado sin token (401) e invalidación por `catalog.changed`; colas de RabbitMQ con 2 consumidores; *cache miss* resuelto por el worker con `catalog.refresh` |
| 03 | [03-perf-compose.png](03-perf-compose.png) | Línea base: 917 req/s en el catálogo y 321 req/s en reseñas, 0 errores, y 5 000 reseñas guardadas en MongoDB |

## 2. K3s en k3d (1 server + 1 agent)

| # | Evidencia | Qué muestra |
|---|-----------|-------------|
| 05 | [05-cluster-k3s-up.log](05-cluster-k3s-up.log) | Creación del clúster y despliegue en el orden de `clusters/dev`: operadores → configuración → secretos → datos → colas → aplicación |
| 06 | [06-k3s-funcional.png](06-k3s-funcional.png) | Nodos `Ready`; pods de la app y de la capa de datos repartidos en los 2 nodos (Galera ×3, MaxScale ×2, MongoDB ×3, RabbitMQ ×3, Redis ×3 + Sentinel ×3); pruebas por el Ingress de Traefik; colas **quorum**; Galera con 3 nodos |
| 07 | [07-tienda-k3s.png](07-tienda-k3s.png) | La tienda servida desde Kubernetes: el título muestra el pod que respondió y cada petición el pod de la API |
| 08 | [08-perf-k3s.png](08-perf-k3s.png) | Desempeño en K3s: 953 req/s en el catálogo con 0 errores; la cola absorbe 2 267 mensajes y se vacía en 35 s; el rate limit de Traefik responde 429 |
| 09 | [09-caos-k3s.png](09-caos-k3s.png) | 8 experimentos de Chaos Mesh (matar API, web, Galera, primario de MongoDB, maestro de Redis, RabbitMQ; tumbar workers; latencia de red), con **0 peticiones fallidas** en todos |
| 10 | [10-perdida-nodo-k3s.png](10-perdida-nodo-k3s.png) | Pérdida del nodo agent: la tienda cae porque MongoDB y Redis Sentinel pierden la mayoría con solo 2 nodos (limitación documentada) |
| 11 | [11-k3s-tras-reinicio.log](11-k3s-tras-reinicio.log) | Apagado y encendido completo del clúster (`k3d cluster stop/start`): Galera se recupera sola en 160 s desde el nodo con el `seqno` más alto, todas las dependencias en `ok` y una reseña nueva guardada por el worker. Para generar la imagen: `scripts/capturar-evidencia.sh log docs/evidencias/11-k3s-tras-reinicio.log docs/evidencias/11-k3s-tras-reinicio.png "K3s tras reinicio completo" 760` |

## Problemas encontrados durante la ejecución y cómo se resolvieron

| Problema | Causa | Solución |
|----------|-------|----------|
| MongoDB `unhealthy` en Compose | Volúmenes de una ejecución anterior con otras contraseñas | `docker compose down -v` y volver a levantar ([00-limpieza-volumenes.log](00-limpieza-volumenes.log)) |
| CPU saturada (carga ~100) al crear el clúster | Los HPA escalaron API y worker durante el arranque, en ~6 GB de RAM | Réplicas y HPA reducidos para una sola computadora (`deploy/local/apps`) |
| `store-web` en `CrashLoopBackOff` | Nginx resolvía el colector OTel al arrancar, y la observabilidad es opcional | Resolución por petición con `resolver` y variable (`web/docker/default.conf.template`) |
| Pods reiniciados bajo carga | Sondas de vida con *timeout* de 1–2 s | *Timeouts* de 5 s y 6 fallas antes de reiniciar |
| API y worker sin poder arrancar (`CreateContainerConfigError`) | El Secret de MongoDB publicado en otro namespace tenía un *ownerReference* entre namespaces y Kubernetes lo borraba en bucle | Conexión armada por partes con la contraseña de `store-app-secrets` |
| Redis con dos maestros tras la pérdida de nodo | Con 2 nodos, los Sentinels no tienen mayoría para promover un maestro | Reparación manual documentada en el [runbook](../runbooks/node-loss.md) |
| Medición de reseñas con 400 en K3s | `kubectl exec -i` dejó vacío el cuerpo de la petición de `ab` | El cuerpo se pasa como argumento y se verifica su tamaño (`pruebas/plataforma/run-perf.sh`) |
