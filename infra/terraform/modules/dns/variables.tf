variable "zone_id" {
  description = "Cloudflare zone id of the domain."
  type        = string
}

variable "records" {
  description = "CNAME records by host name: the Fly host name each one points to. TLS certificates are issued by Fly (fly-app module) for the same names."
  type        = map(string)
}

variable "proxied" {
  description = "Send traffic through Cloudflare, which is what puts the WAF module's rules in front of the host. Turn off only to debug certificate issuance."
  type        = bool
  default     = true
}
