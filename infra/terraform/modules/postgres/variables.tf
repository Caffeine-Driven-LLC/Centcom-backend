variable "name" {
  description = "Fly app name of the database, centcom-<env>-db."
  type        = string
}

variable "org" {
  description = "Fly organisation slug."
  type        = string
}

variable "regions" {
  description = "Regions of the database machines. The first is the primary; with ha = true every further region holds a replica."
  type        = list(string)

  validation {
    condition     = length(var.regions) >= 1 && length(distinct(var.regions)) == length(var.regions)
    error_message = "List at least one region, each once."
  }
}

variable "ha" {
  description = "High availability: a replica in every region after the first, with automatic failover (repmgr). Needs at least two regions."
  type        = bool
  default     = false

  validation {
    condition     = !var.ha || length(var.regions) >= 2
    error_message = "ha = true needs at least two regions."
  }
}

variable "volume_size_gb" {
  description = "Size of each machine's data volume."
  type        = number
  default     = 10
}

variable "cpus" {
  type    = number
  default = 1
}

variable "memory_mb" {
  type    = number
  default = 1024
}

variable "image" {
  description = "Postgres 16 image with repmgr. Pinned; bump it on purpose."
  type        = string
  default     = "flyio/postgres-flex:16.6"
}
