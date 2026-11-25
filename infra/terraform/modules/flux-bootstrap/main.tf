# Instala Flux en el clúster y lo conecta al repositorio (Fase 1 / Fase 5).
# Terraform SOLO hace el bootstrap: todo lo demás lo despliega Flux desde Git.
#  - Deploy key SSH con escritura (Image Automation hace commits de etiquetas)
#  - flux_bootstrap_git: controladores + GitRepository/Kustomization en clusters/<env>
#  - Secret sops-age para descifrar deploy/secrets/<env>
#  - Secrets opcionales de notificaciones (GitHub commit status, Slack)

resource "github_repository_deploy_key" "flux" {
  title      = "flux-${var.environment}"
  repository = var.github_repository
  key        = var.flux_public_key_openssh
  read_only  = false
}

resource "flux_bootstrap_git" "this" {
  depends_on = [github_repository_deploy_key.flux]

  embedded_manifests = true
  path               = "clusters/${var.environment}"
  components_extra   = ["image-reflector-controller", "image-automation-controller"]
  interval           = "1m0s"
}

resource "kubernetes_secret_v1" "sops_age" {
  depends_on = [flux_bootstrap_git.this]
  metadata {
    name      = "sops-age"
    namespace = "flux-system"
  }
  data = {
    "age.agekey" = file(pathexpand(var.age_key_file))
  }
}

resource "kubernetes_secret_v1" "github_token" {
  count      = var.github_status_token == "" ? 0 : 1
  depends_on = [flux_bootstrap_git.this]
  metadata {
    name      = "github-token"
    namespace = "flux-system"
  }
  data = { token = var.github_status_token }
}

resource "kubernetes_secret_v1" "slack_webhook" {
  count      = var.slack_webhook_url == "" ? 0 : 1
  depends_on = [flux_bootstrap_git.this]
  metadata {
    name      = "slack-webhook"
    namespace = "flux-system"
  }
  data = { address = var.slack_webhook_url }
}
