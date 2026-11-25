# Runbook: pérdida de un nodo

Con 3 servidores K3s (etcd embebido), el clúster tolera la pérdida de **1** nodo.

> **Equipo de 2 computadoras (1 server + 1 agent).** Perder el **agent** se maneja como
> describe la tabla. Perder el **server** detiene el plano de control: la API de
> Kubernetes, Flux y la reprogramación de pods. Los pods del agent siguen corriendo, pero
> Galera y las colas quorum pueden quedar sin mayoría si 2 de sus 3 réplicas estaban en el
> server. Recuperación: encender el server (`sudo systemctl start k3s`) y verificar
> `kubectl get nodes`.

## Síntomas
- `kubectl get nodes` muestra un nodo `NotReady`.
- Alertas `StoreGaleraDegraded` (cluster_size 2), Nagios externo con `/readyz` caído en
  ese nodo.

## Qué pasa automáticamente
| Componente | Comportamiento |
|------------|----------------|
| etcd / API | 2 de 3 miembros mantienen quórum; la API sigue disponible |
| MetalLB / Ingress | la VIP se anuncia desde otro nodo (L2) |
| web / API / worker | el Service deja de enviar a los pods del nodo; tras ~5 min (`unreachable` toleration) se reprograman |
| Galera | 2/3 nodos conservan quórum; MaxScale saca el nodo caído |
| MongoDB | si cae el primario, el replica set elige otro en segundos |
| Redis | Sentinel (quórum 2/3) promueve una réplica |
| RabbitMQ | las colas quorum siguen con 2/3 réplicas |

## Acciones
1. Confirmar qué nodo y por qué (`kubectl describe node <n>`, acceso físico/SSH).
2. Si vuelve en minutos: `sudo systemctl start k3s` en ese nodo y verificar `Ready`.
   Galera se resincroniza solo (IST/SST); revisar `store_galera_cluster_size` = 3.
3. Si no vuelve: `kubectl drain <n> --ignore-daemonsets --delete-emptydir-data --force`
   y `kubectl delete node <n>`. Los PVC `local-path` de ese nodo se pierden: borrar el PVC
   del miembro afectado (Galera/Mongo/RabbitMQ) para que el operador lo recree y
   resincronice desde los otros miembros.
4. Reemplazar la computadora: agregarla a `terraform.tfvars` y `terraform apply`.

## Dos nodos caídos
etcd pierde quórum (la API de Kubernetes deja de aceptar escrituras) y Galera también. Los
pods en ejecución siguen sirviendo lecturas cacheadas. Recuperar al menos un nodo; si no es
posible, `k3s server --cluster-reset` en el nodo sobreviviente (ver documentación de K3s)
y restaurar respaldos.

## Redis con dos maestros tras recuperar el nodo (clúster de 2 nodos)
Visto en la prueba de pérdida de nodo del 2026-11-24 (`docs/evidencias/`). Con 2 nodos,
2 de los 3 Sentinels pueden quedar en el nodo caído: el que queda no tiene mayoría para
promover una réplica. Al volver el nodo, los pods de Redis reinician con IPs nuevas y
pueden quedar **dos maestros**. Los Sentinels reiniciados reportan `0.0.0.0` como
maestro, y la API no arranca (`Application startup failed: no valid master node`).

Diagnóstico:
```bash
PW=$(kubectl -n store-data get secret redis-credentials -o jsonpath='{.data.password}' | base64 -d)
for p in store-redis-0 store-redis-1 store-redis-2; do kubectl -n store-data exec $p -- redis-cli -a "$PW" --no-auth-warning info replication | grep -E '^role|master_host'; done
for s in 0 1 2; do kubectl -n store-data exec store-redis-sentinel-sentinel-$s -- redis-cli -p 26379 sentinel get-master-addr-by-name mymaster; done
```

Reparación (elegir un maestro, convertir los demás en réplicas y reapuntar los Sentinels):
```bash
M=$(kubectl -n store-data get pod store-redis-0 -o jsonpath='{.status.podIP}')
for p in store-redis-1 store-redis-2; do kubectl -n store-data exec $p -- redis-cli -a "$PW" --no-auth-warning replicaof $M 6379; done
for s in 0 1 2; do kubectl -n store-data exec store-redis-sentinel-sentinel-$s -- sh -c "redis-cli -p 26379 sentinel remove mymaster; redis-cli -p 26379 sentinel monitor mymaster $M 6379 2; redis-cli -p 26379 sentinel set mymaster auth-pass '$PW'"; done
kubectl -n store rollout restart deploy/store-api deploy/store-worker
```
Redis es una caché desechable: no se pierde información (la API vuelve a llenarla desde
MariaDB). Con 3 nodos (un Sentinel por nodo) la promoción es automática y esto no ocurre.

## Apagado y encendido completo del clúster
Visto el 2026-11-24 al pausar el trabajo (`k3d cluster stop store` y, horas después,
`k3d cluster start store`):
- **Galera** no sabe qué nodo tiene los datos más recientes. Los pods entran en
  `CrashLoopBackOff` unos minutos hasta que mariadb-operator compara los `seqno` de cada
  nodo y arranca el clúster desde el más reciente (`status.galeraRecovery`). Tardó
  **160 s** sin intervención:
  ```bash
  kubectl -n store-data get mariadb store-mariadb -o jsonpath='{.status.galeraRecovery}'
  ```
- **MongoDB, RabbitMQ y Redis** volvieron solos. Redis quedó con un solo maestro, porque
  los dos nodos arrancaron juntos.
- La API y el worker conviene reiniciarlos cuando las bases ya estén listas:
  `kubectl -n store rollout restart deploy/store-api deploy/store-worker`.
