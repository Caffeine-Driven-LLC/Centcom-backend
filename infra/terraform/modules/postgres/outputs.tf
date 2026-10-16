output "app_name" {
  value = fly_app.db.name
}

output "url_secret_name" {
  description = "Name of the Fly secret that holds the connection string in the api, worker and relay apps. The value is set through the secret manager at deploy time, never here."
  value       = "DATABASE_URL"
}

output "host" {
  description = "Private host name of the database inside the organisation network."
  value       = "${fly_app.db.name}.flycast"
}

output "ha" {
  value = var.ha
}

output "regions" {
  value = local.machine_regions
}
