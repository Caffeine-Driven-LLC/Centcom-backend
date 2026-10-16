# Postgres 16 on Fly machines (flyio/postgres-flex): one machine and one volume per region, the
# first region the primary. Passwords (SU_PASSWORD, OPERATOR_PASSWORD, REPL_PASSWORD) are Fly
# secrets set at deploy time (infra/fly/SECRETS.md); this module only names them.
# Extension point for B099: backup and point-in-time recovery resources go in
# infra/terraform/modules/backup/ and take the app name from the output below.

locals {
  machine_regions = var.ha ? var.regions : [var.regions[0]]
}

resource "fly_app" "db" {
  name = var.name
  org  = var.org
}

resource "fly_volume" "data" {
  for_each = toset(local.machine_regions)

  app    = fly_app.db.name
  name   = "pg_data"
  region = each.value
  size   = var.volume_size_gb
}

resource "fly_machine" "db" {
  for_each = toset(local.machine_regions)

  app      = fly_app.db.name
  region   = each.value
  name     = "${var.name}-${each.value}"
  image    = var.image
  cpus     = var.cpus
  memorymb = var.memory_mb

  env = {
    FLY_APP_NAME   = fly_app.db.name
    PRIMARY_REGION = var.regions[0]
  }

  mounts = [{
    path   = "/data"
    volume = fly_volume.data[each.value].id
  }]
}
