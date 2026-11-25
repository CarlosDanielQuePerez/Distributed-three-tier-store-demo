output "kubeconfig_path" {
  value      = var.kubeconfig_path
  depends_on = [terraform_data.kubeconfig]
}

output "api_server" {
  value = "https://${var.nodes[0].address}:6443"
}

output "cluster_token" {
  value     = random_password.cluster_token.result
  sensitive = true
}
