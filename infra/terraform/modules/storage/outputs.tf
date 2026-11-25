output "k3s_args" {
  description = "Argumentos de K3s para usar este directorio como almacenamiento por defecto."
  value       = { "default-local-storage-path" = var.data_path }
  depends_on  = [terraform_data.data_dir]
}
