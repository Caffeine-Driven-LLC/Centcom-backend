output "api_url" {
  value = "https://${local.api_host}"
}

output "relay_urls" {
  description = "Relay WebSocket base URL by region."
  value       = { for r, host in local.relay_hosts : r => "wss://${host}" }
}

output "database_url_secret_name" {
  value = module.postgres.url_secret_name
}

output "redis_url_secret_name" {
  value = module.redis.url_secret_name
}

output "bucket_names" {
  value = module.r2.bucket_names
}

output "fly_app_names" {
  value = {
    api      = module.api.name
    relay    = module.relay.name
    worker   = module.worker.name
    admin    = module.admin.name
    postgres = module.postgres.app_name
    redis    = module.redis.app_name
  }
}

output "scale" {
  description = "Where and how many machines each service runs. infra/fly/gen.mjs writes the same numbers into the fly.<service>.<env>.toml files; a test keeps the two equal."
  value = {
    api      = { regions = var.regions_api, count = var.machine_sizes.api.count }
    relay    = { regions = var.regions_relay, count_per_region = var.machine_sizes.relay.count_per_region }
    worker   = { regions = [var.region_primary], count = var.machine_sizes.worker.count }
    admin    = { regions = [var.region_primary], count = var.machine_sizes.admin.count }
    postgres = { regions = module.postgres.regions, ha = module.postgres.ha }
  }
}
