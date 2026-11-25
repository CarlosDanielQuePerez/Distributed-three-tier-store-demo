terraform {
  required_version = ">= 1.6.0"
  required_providers {
    flux       = { source = "fluxcd/flux", version = "~> 1.4" }
    github     = { source = "integrations/github", version = "~> 6.2" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.31" }
  }
}
