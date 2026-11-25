# Estado remoto con bloqueo (S3 compatible: MinIO, AWS S3, Ceph RGW...).
# El bloqueo usa un archivo .tflock en el bucket (use_lockfile, Terraform >= 1.10 /
# OpenTofu >= 1.10), así que no hace falta DynamoDB.
#   terraform init -backend-config=backend.hcl
# Para probar sin estado remoto: terraform init -backend=false (solo validate/plan).
terraform {
  backend "s3" {}
}
