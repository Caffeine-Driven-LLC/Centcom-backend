output "app_name" {
  value = fly_app.redis.name
}

output "url_secret_name" {
  description = "Name of the Fly secret that holds the Redis URL in the api, worker and relay apps (value set at deploy time)."
  value       = "REDIS_URL"
}

output "host" {
  value = "${fly_app.redis.name}.flycast"
}
