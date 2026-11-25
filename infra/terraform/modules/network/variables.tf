variable "nodes" {
  description = "Nodos del clúster (uno por computadora). role = server (plano de control + etcd) o agent (solo cargas). El primero debe ser server y hace el bootstrap."
  type = list(object({
    name     = string
    address  = string
    ssh_user = string
    role     = optional(string, "server")
  }))
  validation {
    condition     = alltrue([for n in var.nodes : contains(["server", "agent"], n.role)])
    error_message = "role debe ser \"server\" o \"agent\"."
  }
  validation {
    condition     = length(var.nodes) >= 2 && var.nodes[0].role == "server"
    error_message = "Se necesitan al menos 2 nodos (uno por computadora) y el primero debe ser server."
  }
  validation {
    # Con 2 servidores etcd pierde quórum si cae cualquiera: usar 1 o 3 (impar).
    condition     = length([for n in var.nodes : n if n.role == "server"]) % 2 == 1
    error_message = "El número de servidores debe ser impar (1, 3, 5). Con 2 computadoras: 1 server + 1 agent."
  }
}

variable "ssh_private_key_path" {
  type        = string
  description = "Llave privada SSH con acceso sudo a todos los nodos."
}

variable "lan_cidr" {
  type        = string
  description = "Red de la LAN de los nodos, p. ej. 192.168.1.0/24."
  validation {
    condition     = can(cidrnetmask(var.lan_cidr))
    error_message = "lan_cidr debe ser un CIDR IPv4 válido."
  }
}

variable "metallb_range" {
  type        = string
  default     = ""
  description = "Rango libre de la LAN para las VIP de MetalLB (inicio-fin). Vacío en modo tailscale."
  validation {
    condition     = var.metallb_range == "" || can(regex("^\\d+\\.\\d+\\.\\d+\\.\\d+-\\d+\\.\\d+\\.\\d+\\.\\d+$", var.metallb_range))
    error_message = "metallb_range debe tener el formato 192.168.1.240-192.168.1.250."
  }
}

variable "overlay" {
  type        = string
  default     = "lan"
  description = "lan: nodos en la misma LAN (Linux nativo o VM en puente). tailscale: nodos en WSL/NAT unidos por Tailscale."
  validation {
    condition     = contains(["lan", "tailscale"], var.overlay)
    error_message = "overlay debe ser lan o tailscale."
  }
}
