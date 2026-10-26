terraform {
  required_version = ">= 1.10.0"

  required_providers {
    fly = {
      source  = "fly-apps/fly"
      version = "0.0.23"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.28.1"
    }
  }

  # State lives in an S3-compatible bucket of its own (centcom-dev-tfstate, created by hand once:
  # see infra/README.md) with a lock file next to the state. The bucket, endpoint and credentials
  # come from backend.hcl and the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY), never
  # from a committed file.
  backend "s3" {
    key                         = "dev/terraform.tfstate"
    region                      = "auto"
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}

# Tokens come from FLY_API_TOKEN and CLOUDFLARE_API_TOKEN in the environment.
provider "fly" {}

provider "cloudflare" {}
