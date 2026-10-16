variable "env" {
  description = "Environment name; part of every bucket name so no bucket is shared between environments."
  type        = string

  validation {
    condition     = contains(["dev", "stage", "prod"], var.env)
    error_message = "env must be dev, stage or prod."
  }
}

variable "account_id" {
  description = "Cloudflare account id (an identifier, not a credential)."
  type        = string
}

variable "location" {
  description = "R2 location hint, such as enam, weur or apac."
  type        = string
  default     = "enam"
}

variable "buckets" {
  description = "The buckets of the environment, by purpose. delete_after_days removes objects after that age (null keeps them: retention is the application's job, B085). lock_days makes objects immutable for that long (R2 has no object versioning; the lock is what protects backups)."
  type = map(object({
    delete_after_days = optional(number)
    lock_days         = optional(number)
  }))

  default = {
    history   = {}
    snapshots = { delete_after_days = 90 }
    exports   = { delete_after_days = 30 }
    releases  = {}
    backups   = { delete_after_days = 90, lock_days = 30 }
  }
}
