variable "name" {
  description = "Fly app name, centcom-<env>-<service>."
  type        = string

  validation {
    condition     = can(regex("^centcom-(dev|stage|prod)-[a-z]+$", var.name))
    error_message = "The app name must be centcom-<env>-<service> (dev, stage or prod)."
  }
}

variable "org" {
  description = "Fly organisation slug that owns the app. One organisation per environment keeps credentials apart."
  type        = string
}

variable "public" {
  description = "True for an app that takes traffic from the internet: it gets IP addresses and one certificate per host name. False keeps the app on the private network only (no IP, no certificate)."
  type        = bool
  default     = false
}

variable "hostnames" {
  description = "Host names served by the app (certificates are issued for them). Must be empty when the app is private."
  type        = list(string)
  default     = []

  validation {
    condition     = var.public || length(var.hostnames) == 0
    error_message = "A private app cannot have host names."
  }
}
