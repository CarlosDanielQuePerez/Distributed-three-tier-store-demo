variable "nodes" {
  type = list(object({
    name     = string
    address  = string
    ssh_user = string
    role     = optional(string, "server")
  }))
}

variable "ssh_private_key_path" {
  type = string
}

variable "k3s_version" {
  type        = string
  description = "Versión fija de K3s (las actualizaciones se hacen cambiando esta variable)."
  default     = "v1.33.5+k3s1"
}

variable "extra_tls_sans" {
  type    = list(string)
  default = []
}

variable "extra_args" {
  type        = map(string)
  default     = {}
  description = "Opciones adicionales de config.yaml (p. ej. las del módulo storage)."
}

variable "kubeconfig_path" {
  type        = string
  description = "Ruta local donde se escribe el kubeconfig del clúster."
}

variable "flannel_iface" {
  type        = string
  default     = ""
  description = "Interfaz para el tráfico entre nodos (flannel). \"tailscale0\" cuando los nodos están en WSL detrás de NAT."
}

variable "disable_servicelb" {
  type        = bool
  default     = true
  description = "true si MetalLB da las IP de LoadBalancer (LAN). false para usar servicelb de K3s (red Tailscale/WSL)."
}
