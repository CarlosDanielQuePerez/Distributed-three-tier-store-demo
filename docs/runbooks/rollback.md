# Runbook: rollback

Git es la fuente de verdad: el rollback es un `git revert`, no un `kubectl`.

## Aplicación
1. Identificar el commit que introdujo la versión mala (en dev suele ser el commit de
   `fluxcdbot` "actualizar imágenes"; en prod el merge del PR de promoción).
2. Revertir y subir:
   ```bash
   git revert <sha> && git push
   ```
3. Flux aplica la versión anterior en el siguiente intervalo (o forzar con
   `flux reconcile kustomization apps --with-source`).
4. En dev, pausar la automatización de imágenes mientras se corrige, para que no vuelva a
   subir la etiqueta mala:
   ```bash
   flux suspend image update store-dev
   ```
   Reanudar con `flux resume image update store-dev`.

## Emergencia (sin esperar a Git)
```bash
kubectl -n store rollout undo deploy/store-api
```
Es temporal: Flux lo revierte en la siguiente reconciliación. Para que se mantenga,
suspender `apps` (`flux suspend kustomization apps`) y hacer el `git revert` de todos modos.

## Drift
Cualquier cambio manual (`kubectl edit/scale`) en recursos gestionados por Flux se
sobrescribe en el siguiente intervalo. Para comprobarlo:
`kubectl -n store scale deploy/store-web --replicas=1` y observar que vuelve a 3.

## Base de datos
Una migración no se revierte con `git revert`: crear una migración nueva que deshaga el
cambio, o restaurar un respaldo ([backup-restore.md](backup-restore.md)).
