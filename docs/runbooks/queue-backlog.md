# Runbook: acumulación en la cola de reseñas

## Alertas
- `StoreReviewsQueueBacklog`: más de 500 mensajes en `reviews.created` durante 5 min.
- `StoreReviewsNoConsumers`: ningún consumidor durante 2 min.
- `StoreDeadLetterQueueNotEmpty`: hay mensajes en `reviews.dlq`.

## Diagnóstico
```bash
kubectl -n store-data exec store-rabbitmq-server-0 -c rabbitmq -- rabbitmqctl list_queues name messages consumers
```
```bash
kubectl -n store get pods -l app.kubernetes.io/name=store-worker
```
```bash
kubectl -n store logs -l app.kubernetes.io/name=store-worker --tail=100
```
- En Grafana: `store_messages_processed_total` por `outcome` (¿`retried` o `dead_lettered` crecen?).
- En Tempo: buscar trazas de `store-worker` con error para ver qué dependencia falla.

## Causas y acciones
| Causa | Acción |
|-------|--------|
| Workers caídos / CrashLoop | revisar logs; `kubectl -n store rollout restart deploy/store-worker` |
| MongoDB sin primario | ver `kubectl -n store-data get mongodbcommunity`; los mensajes se reintentan (1s/5s/30s) y no se pierden |
| Pico de tráfico | KEDA (prod) escala hasta 10 workers; en dev `kubectl -n store scale deploy/store-worker --replicas=6` (temporal) |
| Mensajes envenenados | quedan en `reviews.dlq` con el header `x-last-error` |

## Reprocesar la DLQ
Tras corregir la causa, mover los mensajes de vuelta con un *shovel* dinámico (es
idempotente: los duplicados se ignoran por la `Idempotency-Key`). El shovel se borra solo
cuando vacía la cola.
```bash
kubectl -n store-data exec store-rabbitmq-server-0 -c rabbitmq -- rabbitmq-plugins enable rabbitmq_shovel rabbitmq_shovel_management
```
```bash
kubectl -n store-data exec store-rabbitmq-server-0 -c rabbitmq -- rabbitmqctl set_parameter shovel dlq-replay '{"src-protocol":"amqp091","src-uri":"amqp://","src-queue":"reviews.dlq","dest-protocol":"amqp091","dest-uri":"amqp://","dest-exchange":"store.events","dest-exchange-key":"reviews.created","src-delete-after":"queue-length"}'
```
Para pocos mensajes también sirve la consola de administración (port-forward al puerto
15672): "Get messages" en `reviews.dlq` y volver a publicarlos en `store.events` con la
routing key `reviews.created`.
