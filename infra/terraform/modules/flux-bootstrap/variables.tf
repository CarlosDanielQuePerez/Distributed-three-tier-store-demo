variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment debe ser dev o prod."
  }
}

variable "github_repository" {
  type        = string
  description = "Nombre del repositorio (sin el owner)."
}

variable "flux_public_key_openssh" {
  type = string
}

variable "age_key_file" {
  type        = string
  description = "Archivo con la llave privada age (age-keygen). No se versiona."
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
