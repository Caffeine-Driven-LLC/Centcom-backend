# One whole environment: the four Fly apps, Postgres, Redis, the R2 buckets and the DNS records.
# The three roots in ../../envs call this with their own tfvars and their own state, so nothing in
# one environment can name a resource of another.

locals {
  prefix = "centcom-${var.env}"
  base   = var.env == "prod" ? var.domain : "${var.env}.${var.domain}"

  api_host      = "api.${local.base}"
  releases_host = "releases.${local.base}"
  relay_hosts   = { for r in var.regions_relay : r => "relay-${r}.${local.base}" }
}

module "api" {
  source = "../fly-app"

  name      = "${local.prefix}-api"
  org       = var.fly_org
  public    = true
  hostnames = [local.api_host, local.releases_host]
}

module "relay" {
  source = "../fly-app"

  name      = "${local.prefix}-relay"
  org       = var.fly_org
  public    = true
  hostnames = values(local.relay_hosts)
}

module "worker" {
  source = "../fly-app"

  name = "${local.prefix}-worker"
  org  = var.fly_org
}

# The admin console is on the private network only: no IP address, no certificate, no DNS record.
module "admin" {
  source = "../fly-app"

  name = "${local.prefix}-admin"
  org  = var.fly_org
}

module "postgres" {
  source = "../postgres"

  name           = "${local.prefix}-db"
  org            = var.fly_org
  regions        = var.postgres_regions
  ha             = var.postgres_ha
  cpus           = var.machine_sizes.postgres.cpus
  memory_mb      = var.machine_sizes.postgres.memory_mb
  volume_size_gb = var.machine_sizes.postgres.volume_gb
}

module "redis" {
  source = "../redis"

  name           = "${local.prefix}-redis"
  org            = var.fly_org
  region         = var.region_primary
  cpus           = var.machine_sizes.redis.cpus
  memory_mb      = var.machine_sizes.redis.memory_mb
  volume_size_gb = var.machine_sizes.redis.volume_gb
}

module "r2" {
  source = "../r2"

  env        = var.env
  account_id = var.cloudflare_account_id
  location   = var.r2_location
}

# The releases host name is served by the API (presigned downloads), so it points at the api app.
module "dns" {
  source = "../dns"

  zone_id = var.cloudflare_zone_id
  records = merge(
    {
      (local.api_host)      = module.api.fly_hostname
      (local.releases_host) = module.api.fly_hostname
    },
    { for r, host in local.relay_hosts : host => module.relay.fly_hostname },
  )
}
