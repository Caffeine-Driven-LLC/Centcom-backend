# One Fly app and, when it is public, its IP addresses and certificates. Machines are not managed
# here: `fly deploy` (B092) creates them from infra/fly/fly.<service>.<env>.toml, so regions,
# sizes, health checks and the relay's kill_timeout live in one reviewed file per service.

resource "fly_app" "this" {
  name = var.name
  org  = var.org
}

resource "fly_ip" "v6" {
  count = var.public ? 1 : 0

  app  = fly_app.this.name
  type = "v6"
}

resource "fly_ip" "shared_v4" {
  count = var.public ? 1 : 0

  app  = fly_app.this.name
  type = "shared_v4"
}

resource "fly_cert" "host" {
  for_each = toset(var.hostnames)

  app      = fly_app.this.name
  hostname = each.value
}
