variable "nodes" {
  description = "Un nodo por computadora del equipo (3 o 5)."
  type = list(object({
    name     = string
    address  = string
    ssh_user = string
    role     = optional(string, "server")
  }))
}

variable "ssh_private_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519"
}

variable "lan_cidr" {
  type = string
}

variable "metallb_range" {
  type    = string
  default = ""
}

variable "overlay" {
  type        = string
  default     = "lan"
  description = "lan (misma LAN, MetalLB) o tailscale (WSL detrás de NAT, servicelb)."
}

variable "data_path" {
  type    = string
  default = "/var/lib/store-data"
}

variable "k3s_version" {
  type    = string
  default = "v1.33.5+k3s1"
}

variable "extra_tls_sans" {
  type    = list(string)
  default = []
}

variable "github_owner" {
  type    = string
  default = "CarlosDanielQuePerez"
}

variable "github_repository" {
  type    = string
  default = "Distributed-three-tier-store-demo"
}

variable "age_key_file" {
  type    = string
  default = "../../../../age.key"
}

variable "github_status_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "slack_webhook_url" {
  type      = string
  default   = ""
  sensitive = true
}
