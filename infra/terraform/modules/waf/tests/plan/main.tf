# A root module that plans the waf module with dummy values, so the plan can be inspected offline
# (`terraform show -json`). Nothing here talks to Cloudflare: new resources need no API call, and
# the token is a placeholder. Regenerate the fixture with ../../tests/gen-plan.sh.
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = "0000000000000000000000000000000000000000"
}

variable "mode" {
  type    = string
  default = "block"
}

module "waf" {
  source          = "../.."
  zone_id         = "00000000000000000000000000000000"
  api_hostname    = "api.example.com"
  relay_hostnames = ["relay.example.com"]
  mode            = var.mode
}

output "ids" {
  value = module.waf.ruleset_ids
}
