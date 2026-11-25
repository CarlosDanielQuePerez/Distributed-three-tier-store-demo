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

variable "data_path" {
  type        = string
  default     = "/var/lib/store-data"
  description = "Directorio para los volúmenes persistentes de local-path."
}
