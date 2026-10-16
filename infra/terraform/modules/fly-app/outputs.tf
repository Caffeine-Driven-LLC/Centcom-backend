output "name" {
  description = "The Fly app name."
  value       = fly_app.this.name
}

output "fly_hostname" {
  description = "The app's own fly.dev host name (the target of the DNS records), or its private .internal name."
  value       = var.public ? "${fly_app.this.name}.fly.dev" : "${fly_app.this.name}.internal"
}

output "public" {
  description = "Whether the app is reachable from the internet."
  value       = var.public
}
