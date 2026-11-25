# Runbook: incidente de seguridad

## Fuentes de detección
- **Wazuh** (dashboard en el namespace `wazuh`): FIM sobre `/etc/rancher`, manifiestos y
  certificados de K3s y binarios; rootcheck; vulnerabilidades; eventos del audit log de
  Kubernetes (`k3s-audit`).
- **Kyverno**: `kubectl get policyreports -A` (imágenes sin firma, `:latest`, sin límites).
- **Trivy / Dependabot** en GitHub.
- **Loki**: logs de acceso de Traefik y de la tienda (picos de 401/403/429).

## Contención (primeros 15 minutos)
1. Aislar el workload afectado sin borrar evidencia:
   ```bash
   kubectl -n store label pod <pod> quarantine=true --overwrite
   ```
   y aplicar una NetworkPolicy que niegue todo a `quarantine=true`; quitar el pod del
   Service cambiando su etiqueta `app.kubernetes.io/name`.
2. Credenciales expuestas: regenerar con `scripts/generate-secrets.sh <env>` (borrando el
   archivo anterior), hacer commit y reconciliar; reiniciar los Deployments.
   Token de administración de la API: está en `store-app-secrets/API_ADMIN_TOKEN`.
3. Nodo comprometido: `kubectl cordon` + `drain`, desconectarlo de la red y reemplazarlo
   (ver [node-loss.md](node-loss.md)).
4. Imagen comprometida: revertir la etiqueta ([rollback.md](rollback.md)); con Kyverno en
   `Enforce` (prod) solo se admiten imágenes firmadas por `release.yml`.

## Investigación
- Audit log: `/var/lib/rancher/k3s/server/logs/audit.log` en los nodos (también en Wazuh).
- Qué cambió en el clúster: `git log` del repositorio (todo pasa por Git) y
  `flux events`.
- Trazas: Tempo permite seguir una petición sospechosa de extremo a extremo por `trace_id`.

## Notificación a Slack desde Wazuh
En el `ossec.conf` del manager (configmap del repositorio `wazuh-kubernetes`):
```xml
<integration>
  <name>slack</name>
  <hook_url>https://hooks.slack.com/services/XXX</hook_url>
  <level>10</level>
  <alert_format>json</alert_format>
</integration>
```
El *active response* está deshabilitado en los agentes; habilitarlo solo después de
afinar reglas para evitar bloqueos de tráfico legítimo.

## Cierre
Documentar línea de tiempo, causa raíz y acciones; agregar una regla de Kyverno/Wazuh o
una prueba que habría detectado el incidente.
