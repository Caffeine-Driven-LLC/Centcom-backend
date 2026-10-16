# Redis 7 with the append-only file on a volume (fsync every second), so a restart keeps queued
# jobs and presence. The password is the Fly secret REDIS_PASSWORD, read by the entrypoint.

resource "fly_app" "redis" {
  name = var.name
  org  = var.org
}

resource "fly_volume" "data" {
  app    = fly_app.redis.name
  name   = "redis_data"
  region = var.region
  size   = var.volume_size_gb
}

resource "fly_machine" "redis" {
  app      = fly_app.redis.name
  region   = var.region
  name     = var.name
  image    = var.image
  cpus     = var.cpus
  memorymb = var.memory_mb

  entrypoint = [
    "sh", "-c",
    "exec redis-server --appendonly yes --appendfsync everysec --dir /data --protected-mode yes --requirepass \"$REDIS_PASSWORD\"",
  ]

  mounts = [{
    path   = "/data"
    volume = fly_volume.data.id
  }]
}
