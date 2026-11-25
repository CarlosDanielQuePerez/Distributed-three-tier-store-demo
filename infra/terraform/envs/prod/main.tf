# Entorno prod. Aplicar en dos pasos (el provider de Flux necesita el kubeconfig):
#   terraform apply -target=module.k3s     # red, almacenamiento y K3s
#   terraform apply                         # bootstrap de Flux
locals {
  environment     = "prod"
  git_branch      = "release"
  kubeconfig_path = abspath("${path.root}/kubeconfig-prod.yaml")
}

module "network" {
  source               = "../../modules/network"
  nodes                = var.nodes
  ssh_private_key_path = var.ssh_private_key_path
  lan_cidr             = var.lan_cidr
  metallb_range        = var.metallb_range
  overlay              = var.overlay
}

module "storage" {
  source               = "../../modules/storage"
  nodes                = module.network.nodes
  ssh_private_key_path = var.ssh_private_key_path
  data_path            = var.data_path
}

module "k3s" {
  source               = "../../modules/k3s-nodes"
  nodes                = module.network.nodes
  ssh_private_key_path = var.ssh_private_key_path
  k3s_version          = var.k3s_version
  extra_args           = module.storage.k3s_args
  extra_tls_sans       = var.extra_tls_sans
  flannel_iface        = var.overlay == "tailscale" ? "tailscale0" : ""
  disable_servicelb    = var.overlay == "lan"
  kubeconfig_path      = local.kubeconfig_path
}

resource "tls_private_key" "flux" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

provider "github" {
  owner = var.github_owner
  # Token en la variable de entorno GITHUB_TOKEN (permiso de administración del repo
  # solo para crear la deploy key).
}

provider "kubernetes" {
  config_path = local.kubeconfig_path
}

provider "flux" {
  kubernetes = {
    config_path = local.kubeconfig_path
  }
  git = {
    url    = "ssh://git@github.com/${var.github_owner}/${var.github_repository}.git"
    branch = local.git_branch
    ssh = {
      username    = "git"
      private_key = tls_private_key.flux.private_key_pem
    }
  }
}

module "flux" {
  source                  = "../../modules/flux-bootstrap"
  depends_on              = [module.k3s]
  environment             = local.environment
  github_repository       = var.github_repository
  flux_public_key_openssh = tls_private_key.flux.public_key_openssh
  age_key_file            = var.age_key_file
  github_status_token     = var.github_status_token
  slack_webhook_url       = var.slack_webhook_url
}

output "kubeconfig" {
  value = module.k3s.kubeconfig_path
}

output "api_server" {
  value = module.k3s.api_server
}
