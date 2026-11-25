terraform {
  required_version = ">= 1.10.0"
  required_providers {
    random     = { source = "hashicorp/random", version = "~> 3.6" }
    tls        = { source = "hashicorp/tls", version = "~> 4.0" }
    flux       = { source = "fluxcd/flux", version = "~> 1.4" }
    github     = { source = "integrations/github", version = "~> 6.2" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.31" }
  }
}
