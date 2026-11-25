#!/usr/bin/env bash
# Instala Wazuh manager + indexer + dashboard en el namespace "wazuh" usando el
# repositorio oficial wazuh-kubernetes (Fase 7). Se ejecuta una sola vez por clúster.
#
#   deploy/platform/wazuh/bootstrap.sh            (usa envs/local-env: 1 indexer, recursos bajos)
#
# Requisitos: kubectl con acceso al clúster, git, openssl. Requiere ~4 GB de RAM libres.
set -euo pipefail
VERSION=${WAZUH_VERSION:-v4.14.10}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 --branch "$VERSION" https://github.com/wazuh/wazuh-kubernetes.git "$WORK/wazuh-kubernetes"
cd "$WORK/wazuh-kubernetes"

# Certificados del indexer y del dashboard (se quedan en el clúster como Secrets; no se versionan).
bash wazuh/certs/indexer_cluster/generate_certs.sh
bash wazuh/certs/dashboard_http/generate_certs.sh

# K3s usa local-path como StorageClass por defecto.
sed -i 's/provisioner: .*/provisioner: rancher.io\/local-path/' envs/local-env/storage-class.yaml || true

kubectl apply -k envs/local-env/
kubectl -n wazuh rollout status statefulset/wazuh-manager-master --timeout=15m || true
kubectl -n wazuh get pods
echo
echo "Dashboard: kubectl -n wazuh port-forward svc/dashboard 8443:443  → https://localhost:8443"
echo "Credenciales por defecto en wazuh/secrets/ del repositorio oficial: cámbialas."
