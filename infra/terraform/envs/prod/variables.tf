variable "domain" {
  description = "Registered domain in the Cloudflare zone, such as centcom.example. Production uses it as is; the other environments use <env>.<domain>."
  type        = string
}

variable "fly_org" {
  description = "Fly organisation slug of this environment (one organisation per environment)."
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id that owns the R2 buckets (an identifier, not a credential)."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id of the domain."
  type        = string
}

variable "region_primary" {
  description = "Fly region of the Postgres primary and of Redis."
  type        = string
}

variable "regions_api" {
  description = "Fly regions the api runs in (deploy scale, read from here by infra/fly)."
  type        = list(string)
}

variable "regions_relay" {
  description = "Fly regions the relay runs in; each gets its own host name relay-<region>.<domain>."
  type        = list(string)
}

variable "postgres_regions" {
  description = "Regions of the Postgres machines; the first must be region_primary. With postgres_ha every further region holds a replica."
  type        = list(string)
}

variable "postgres_ha" {
  type = bool
}

variable "r2_location" {
  description = "R2 location hint."
  type        = string
  default     = "enam"
}

variable "machine_sizes" {
  description = "Size and count per service. api.count is the total across regions_api; relay.count_per_region applies to each of regions_relay."
  type = object({
    api = object({
      cpus      = number
      memory_mb = number
      count     = number
    })
    relay = object({
      cpus             = number
      memory_mb        = number
      count_per_region = number
    })
    worker = object({
      cpus      = number
      memory_mb = number
      count     = number
    })
    admin = object({
      cpus      = number
      memory_mb = number
      count     = number
    })
    postgres = object({
      cpus      = number
      memory_mb = number
      volume_gb = number
    })
    redis = object({
      cpus      = number
      memory_mb = number
      volume_gb = number
    })
  })
}
