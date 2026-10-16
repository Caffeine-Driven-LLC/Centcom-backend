module "environment" {
  source = "../../modules/environment"

  env                   = "prod"
  domain                = var.domain
  fly_org               = var.fly_org
  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone_id    = var.cloudflare_zone_id
  region_primary        = var.region_primary
  regions_api           = var.regions_api
  regions_relay         = var.regions_relay
  postgres_regions      = var.postgres_regions
  postgres_ha           = var.postgres_ha
  r2_location           = var.r2_location
  machine_sizes         = var.machine_sizes
}
