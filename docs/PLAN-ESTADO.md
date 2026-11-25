# Estado del plan de migración

Cada casilla del
[PLATFORM-MIGRATION-PLAN.md](https://github.com/tuxtter/distributedsystems/blob/main/PLATFORM-MIGRATION-PLAN.md)
con el archivo que la implementa. ✅ implementado · ◐ implementado con alcance reducido
(ver nota) · ➖ opcional, no implementado.

## Fase 0 – Prerrequisitos
- ✅ Imágenes versionadas, no root y mínimas para web y API; `/healthz` y `/readyz` → `application/Dockerfile`, `web/Dockerfile`, `worker/Dockerfile`, `application/app.js`
- ✅ Configuración 12-factor → `shared/config.js`, `deploy/base/configmap.yaml`
- ✅ Registro GHCR y etiquetas `sha-<commit>` + semver → `.github/workflows/release.yml`

## Fase 1 – IaC con Terraform
- ✅ Módulos `network`, `k3s-nodes`, `flux-bootstrap`, `storage` → `infra/terraform/modules/`
- ◐ K3s con etcd embebido → `modules/k3s-nodes` (un nodo por computadora por SSH). El plan pide 3 servidores en HA; el equipo tiene 2 computadoras, así que se usa **1 server + 1 agent** (2 servidores etcd no toleran fallas). El módulo soporta 3+ servidores con solo cambiar `role` en `terraform.tfvars`
- ✅ Estado remoto con bloqueo; `dev` y `prod` separados → `envs/*/backend.tf` (`use_lockfile`), `envs/dev`, `envs/prod`
- ✅ Bootstrap de Flux con el provider `flux` → `modules/flux-bootstrap`
- ✅ `fmt`, `validate`, `tflint`, `checkov` en CI → `.github/workflows/ci.yml` (job `terraform`)
- ✅ Alternativa local → `scripts/local-cluster.sh` (k3d en una computadora: 1 server + 1 agent, o `SERVERS=3`; modo `gitops` con Flux desde GitHub). Es la que se usó para las pruebas al descomponerse la segunda computadora del equipo

## Fase 2 – Workloads en Kubernetes
- ✅ Kustomize base + overlays dev/prod para web, API, worker, ConfigMaps, Services, Ingress → `deploy/base`, `deploy/overlays`
- ✅ Service/Ingress (Traefik) + MetalLB en lugar de HAProxy + Keepalived → `deploy/base/ingress.yaml`, `deploy/platform/config/metallb-pool.yaml`
- ✅ Requests/limits, probes, HPAs, PDBs, topology spread → `deploy/base/*.yaml`, `autoscaling.yaml`
- ✅ Datos con operadores: MariaDB Operator (Galera) + MaxScale, MongoDB Community Operator, Redis Sentinel (OT operator), RabbitMQ Cluster Operator → `deploy/data`, `deploy/queues`, `deploy/platform/operators`
- ✅ NetworkPolicies default-deny con permisos explícitos por capa → `deploy/base/networkpolicies.yaml`, `deploy/data/networkpolicies.yaml`

## Fase 3 – Colas
- ✅ RabbitMQ 3 réplicas, colas quorum, volúmenes persistentes → `deploy/queues/rabbitmq.yaml`
- ✅ Servicio `worker/` y publicador en la API → `worker/`, `application/app.js`
- ✅ Exchanges, colas, DLQs y esquemas en Git → `messaging/topology.json`, `messaging/schemas/`
- ✅ Alertas de profundidad, consumer lag y DLQ → `deploy/platform/observability/alerts/rules.yaml`
- ✅ Autoescalado de workers por cola con KEDA → `deploy/components/keda-worker` (prod)
- ✅ Caso 1 (reseñas asíncronas, idempotencia, backoff, DLQ), caso 2 (invalidación), caso 3 (calentamiento / estampida)

## Fase 4 – CI/CD con GitHub Actions
- ✅ `ci.yml`: lint, pruebas, imágenes, Trivy, `terraform validate`, kubeconform
- ✅ `release.yml`: GHCR, cosign, SBOM, actualización de etiquetas (Flux image automation en dev, PR en prod)
- ✅ OIDC / sin credenciales de larga duración (GITHUB_TOKEN efímero, cosign keyless)
- ✅ `terraform plan` comentado en PRs; `apply` solo desde `main` con aprobación → `terraform.yml`
- ➖ Jenkins (fuera de alcance según el plan)

## Fase 5 – GitOps con FluxCD
- ✅ Bootstrap: `clusters/<env>/` → `clusters/dev`, `clusters/prod`
- ✅ Promoción: dev sigue `main`, prod sigue `release`, PR como puerta
- ✅ Image automation: `ImageRepository`, `ImagePolicy`, `ImageUpdateAutomation` → `clusters/dev/image-automation.yaml`
- ✅ `dependsOn`: operadores → datos → colas → apps; observabilidad → `clusters/*/infrastructure.yaml`, `apps.yaml`
- ✅ Corrección de drift y rollback con `git revert` → `prune`, `docs/runbooks/rollback.md`
- ✅ Secretos con SOPS (age) → `.sops.yaml`, `scripts/generate-secrets.sh`, Kustomization `secrets`
- ✅ Notificaciones `Provider`/`Alert` a Slack y GitHub → `clusters/*/notifications.yaml`

## Fase 6 – Observabilidad (opcional por RAM)
Implementada completa, pero **suspendida por defecto** (`suspend: true` en `clusters/*/infrastructure.yaml`; en el clúster local, `OBSERVABILITY=1`). El maestro la marcó como opcional porque consume mucha memoria. Se enciende con `flux resume kustomization observability`.

- ✅ Stack LGTM con Helm gestionado por Flux; OTel Collector como gateway → `deploy/platform/observability/prod` (dev: `otel-lgtm`)
- ✅ Node.js con auto-instrumentación (HTTP, Redis, MySQL, MongoDB, AMQP) y propagación por headers de RabbitMQ → `application/telemetry.js`, `worker/telemetry.js`
- ✅ Nginx con `ngx_otel_module` → `web/docker/`
- ◐ Navegador: `traceparent` W3C + span OTLP exportado con un exportador propio en lugar de `@opentelemetry/sdk-trace-web` (sitio estático sin bundler); reemplaza los headers y la UI propios → `web/catalog.js`
- ✅ Collector DaemonSet (agente) + Deployment (gateway) con `k8sattributes` → `observability/base`, `observability/prod/otel-gateway.yaml`
- ✅ Dashboards: RED, cache hit rate, salud de Galera, RabbitMQ, saturación → `dashboards/store-overview.json`
- ✅ SLOs y alertas de burn rate → `alerts/rules.yaml`
- ✅ Nagios externo de caja negra (HTTP, TLS, API de Kubernetes) → `nagios/external-k3s.cfg`

## Fase 7 – Seguridad
- ✅ Wazuh manager/indexer/dashboard en namespace propio; agentes DaemonSet → `deploy/platform/wazuh`
- ✅ FIM, vulnerabilidades, rootcheck, logs de auditoría de K3s → `ossec.conf`, `modules/k3s-nodes/templates/audit-policy.yaml`
- ◐ Integración de alertas de Wazuh con Grafana/Slack: los logs de los nodos llegan a Loki por el OTel agent y el active response queda deshabilitado; la integración nativa Wazuh→Slack se configura en el manager (`ossec.conf` del manager, `<integration>`) y queda documentada en `docs/runbooks/security-incident.md`
- ✅ PSA `restricted`, no root, raíz de solo lectura, RBAC mínimo, kube-bench → `operators/namespaces.yaml`, `security/kube-bench-job.yaml`
- ✅ TLS con cert-manager en el Ingress → `config/cert-manager-issuers.yaml`
- ➖ mTLS entre servicios (opcional, requiere service mesh)
- ✅ Usuarios de MongoDB/Redis/MariaDB con privilegio mínimo; secretos SOPS (ToDo 6)
- ✅ Autenticación de la API (endpoint de administración) y rate limiting en el Ingress
- ✅ Trivy, verificación de firma cosign con Kyverno, Dependabot

## Fase 8 – Corte y validación
- ✅ Compose y K3s en paralelo con corte gradual por pesos → perfil `cutover`, `haproxy/cutover.cfg`
- ✅ Escenarios de resilience-lab en Kubernetes con Chaos Mesh → `deploy/platform/chaos/experiments`, `pruebas/plataforma/run-chaos.sh`
- ✅ Respaldo/restauración de MariaDB, MongoDB y definiciones de RabbitMQ → `deploy/data/backups.yaml`, `docs/runbooks/backup-restore.md`
- ✅ Runbooks: despliegue, rollback, pérdida de nodo, cola acumulada, incidente de seguridad → `docs/runbooks/`
- ✅ HAProxy/Keepalived fuera de la ruta de producción (solo Compose)

## ToDo.md original

| Punto | Resuelto por |
|-------|--------------|
| 1. Más allá de Compose en un host | K3s multinodo, Ingress, HPA; Compose queda para desarrollo |
| 2. Dependencias de una sola instancia | Operadores con réplicas; Redis definido como caché desechable; respaldos |
| 3. Enrutamiento consciente del clúster | MaxScale `readwritesplit` |
| 4. Comportamiento de la caché | Llaves y TTL definidos, invalidación por evento, protección contra estampida, limpieza solo de `store:products:*` |
| 5. Observabilidad | OpenTelemetry + LGTM, dashboards y alertas |
| 6. Seguridad y operación | Usuarios de privilegio mínimo, SOPS, TLS, auth + rate limit, migraciones, runbooks |
