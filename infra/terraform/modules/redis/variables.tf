variable "name" {
  description = "Fly app name of Redis, centcom-<env>-redis."
  type        = string
}

variable "org" {
  type = string
}

variable "region" {
  type = string
}

variable "volume_size_gb" {
  type    = number
  default = 1
}

variable "cpus" {
  type    = number
  default = 1
}

variable "memory_mb" {
  type    = number
  default = 512
}

variable "image" {
  description = "Redis 7 image, pinned."
  type        = string
  default     = "redis:7.4.11-alpine"
}
