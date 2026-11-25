output "nodes" {
  value      = var.nodes
  depends_on = [terraform_data.node_network]
}

output "api_server" {
  description = "Endpoint de la API de Kubernetes (primer nodo)."
  value       = "https://${var.nodes[0].address}:6443"
}

output "metallb_range" {
  value = var.metallb_range
}

output "overlay" {
  value = var.overlay
}
