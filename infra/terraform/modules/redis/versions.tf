terraform {
  required_version = ">= 1.10.0"

  required_providers {
    fly = {
      source  = "fly-apps/fly"
      version = "0.0.23"
    }
  }
}
