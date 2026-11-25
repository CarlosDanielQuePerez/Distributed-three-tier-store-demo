# Runbook: despliegue

## Flujo normal (GitOps)
1. PR a `main` → `ci.yml` debe pasar (lint, pruebas, Trivy, kubeconform, Terraform).
2. Merge → `release.yml` publica `main-<run>-<sha>` firmada en GHCR.
3. Flux (dev) detecta la etiqueta en ≤5 min y hace commit en `deploy/overlays/dev`;
   la Kustomization `apps` aplica el cambio con *rolling update* (`maxUnavailable: 0`).
4. Para prod: `git tag vX.Y.Z && git push origin vX.Y.Z` → se abre el PR "Promover vX.Y.Z
   a prod" hacia `release`. Revisar y aprobar el PR es la puerta de promoción.

## Verificación
```bash
flux get kustomizations
```
```bash
kubectl -n store rollout status deploy/store-api
```
```bash
kubectl -n store get pods -o wide
```
- Grafana → dashboard de la tienda: tasa de 5xx en 0 y p95 estable tras el despliegue.
- `kubectl -n store logs job/store-init` muestra las migraciones aplicadas.

## Forzar una reconciliación
```bash
flux reconcile source git flux-system && flux reconcile kustomization apps --with-source
```

## Cambios de esquema
Agregar un archivo nuevo `database/migrations/NNN_descripcion.sql` (nunca modificar uno ya
aplicado: el checksum lo detecta y el Job falla). El Job `store-init` se recrea con la
nueva imagen.
