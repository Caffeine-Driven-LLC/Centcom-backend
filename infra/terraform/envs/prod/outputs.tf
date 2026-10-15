output "api_url" {
  value = module.environment.api_url
}

output "relay_urls" {
  value = module.environment.relay_urls
}

output "database_url_secret_name" {
  value = module.environment.database_url_secret_name
}

output "redis_url_secret_name" {
  value = module.environment.redis_url_secret_name
}

output "bucket_names" {
  value = module.environment.bucket_names
}

output "fly_app_names" {
  value = module.environment.fly_app_names
}

output "scale" {
  value = module.environment.scale
}
