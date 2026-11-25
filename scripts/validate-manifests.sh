#!/usr/bin/env bash
# Renderiza cada kustomization y la valida con kubeconform (esquemas de Kubernetes y
# de los CRDs del catálogo datreeio). Lo usa CI; también sirve en local.
set -euo pipefail
cd "$(dirname "$0")/.."

DIRS=(
  deploy/platform/sources
  deploy/platform/operators
  deploy/platform/config
  deploy/platform/observability/dev
  deploy/platform/observability/prod
  deploy/platform/wazuh
  deploy/data
  deploy/queues
  deploy/overlays/dev
  deploy/overlays/prod
)
SCHEMAS=(
  -schema-location default
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
)
status=0
for dir in "${DIRS[@]}"; do
  echo "==> $dir"
  if ! kustomize build "$dir" | kubeconform -strict -ignore-missing-schemas -summary "${SCHEMAS[@]}" -; then
    status=1
  fi
done
for file in deploy/platform/chaos/experiments/*.yaml deploy/platform/security/*.yaml clusters/*/*.yaml; do
  kubeconform -strict -ignore-missing-schemas "${SCHEMAS[@]}" "$file" || status=1
done
exit $status
