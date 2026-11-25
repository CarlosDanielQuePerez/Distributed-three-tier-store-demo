# Runbook: respaldo y restauración

| Dato | Respaldo | Frecuencia | Retención | Dónde |
|------|----------|------------|-----------|-------|
| MariaDB `store` | `Backup` CR (mariadb-dump) | diario 03:00 | 7 días | PVC del Backup `store-mariadb-daily` |
| MongoDB `store_reviews` | CronJob `mongodump --gzip` | diario 03:15 | 7 días | PVC `store-backups` |
| RabbitMQ (definiciones) | CronJob `GET /api/definitions` | diario 03:30 | 14 días | PVC `store-backups` |
| Redis | no se respalda (caché desechable) | — | — | — |

Respaldo inmediato (sin esperar al cron):
```bash
kubectl -n store-data create job --from=cronjob/store-mongodb-backup mongo-manual-$(date +%s)
```
```bash
kubectl -n store-data create job --from=cronjob/store-rabbitmq-definitions-backup rmq-manual-$(date +%s)
```

## Restaurar MariaDB
```yaml
apiVersion: k8s.mariadb.com/v1alpha1
kind: Restore
metadata: { name: restore-store, namespace: store-data }
spec:
  mariaDbRef: { name: store-mariadb }
  backupRef: { name: store-mariadb-daily }
  # targetRecoveryTime: "2026-11-30T03:00:00Z"   # elegir un respaldo concreto
```
`kubectl apply -f` y seguir con `kubectl -n store-data get restore restore-store -w`.
Después, vaciar la caché: `curl -X POST https://store.local/api/cache/clear`.

## Restaurar MongoDB
```bash
kubectl -n store-data run mongo-restore --rm -it --restart=Never --image=mongo:7.0.14 --overrides='{"spec":{"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"store-backups"}}],"containers":[{"name":"mongo-restore","image":"mongo:7.0.14","stdin":true,"tty":true,"command":["bash"],"volumeMounts":[{"name":"b","mountPath":"/backups"}]}]}}'
```
Dentro del pod (la contraseña está en el Secret `mongodb-users`, clave `admin-password`):
```bash
ls /backups/mongodb && mongorestore --uri "mongodb://store-admin:<pass>@store-mongodb-svc:27017/?replicaSet=store-mongodb&authSource=admin" --gzip --drop --nsInclude 'store_reviews.*' /backups/mongodb/<fecha>
```

## Restaurar definiciones de RabbitMQ
```bash
kubectl -n store-data port-forward svc/store-rabbitmq 15672:15672
```
```bash
curl -u store_app:<pass> -H 'content-type: application/json' -X POST http://localhost:15672/api/definitions -d @definitions-<fecha>.json
```
(La API y el worker también vuelven a declarar la topología al conectarse.)

## Prueba periódica de restauración
Una vez al mes: restaurar MariaDB y MongoDB en el clúster **dev** desde el respaldo más
reciente de prod, ejecutar `pruebas/plataforma/run-perf.sh` corto y verificar que el
catálogo y las reseñas responden. Registrar la fecha y el resultado en `pruebas/plataforma/`.
