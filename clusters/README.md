# clusters/

Puntos de entrada de Flux, uno por entorno. `flux bootstrap` (lo ejecuta Terraform,
módulo `flux-bootstrap`) crea `clusters/<env>/flux-system/` con los controladores y un
`GitRepository` que apunta a:

| Entorno | Rama Git | Overlay | Observabilidad |
|---------|----------|---------|----------------|
| dev     | `main`    | `deploy/overlays/dev`  | `otel-lgtm` (todo en uno) |
| prod    | `release` | `deploy/overlays/prod` | Loki + Tempo + Mimir + Grafana |

Promoción a prod: PR de `main` → `release`; la aprobación del PR es la puerta.
Rollback: `git revert` del commit en la rama del entorno; Flux revierte el clúster.
Drift: cualquier `kubectl edit` manual se corrige en el siguiente intervalo de reconciliación.
