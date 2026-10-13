variable "zone_id" {
  description = "Cloudflare zone that holds the API and relay host names."
  type        = string
}

variable "api_hostname" {
  description = "Host name of the REST API, such as api.example.com."
  type        = string
}

variable "relay_hostnames" {
  description = "Host names of the relay (WebSocket) endpoints, such as [\"relay.example.com\"]."
  type        = list(string)
}

variable "ws_paths" {
  description = "Paths the relay hosts accept besides the health checks. Exact match: a regex match needs a Business plan, so the card's ws_path_regex is an exact path list here."
  type        = list(string)
  default     = ["/v1/ws"]
}

variable "availability_paths" {
  description = "Paths no rule of this module may ever block (health checks and the status page)."
  type        = list(string)
  default     = ["/healthz", "/readyz", "/v1/status"]
}

variable "rate_limits" {
  description = "Per-IP request limits mirroring the CT-PAGE buckets. period_s is 60 on Pro and above; the Free plan allows one rule with a 10 s period (set period_s = 10 and scale the numbers)."
  type = object({
    anonymous_per_period = number
    auth_per_period      = number
    period_s             = number
    mitigation_timeout_s = number
  })
  default = {
    anonymous_per_period = 30
    auth_per_period      = 20
    period_s             = 60
    mitigation_timeout_s = 60
  }
}

variable "mode" {
  description = "block enforces the rules, log only records matches (a false positive can be investigated without dropping traffic; log needs an Enterprise plan), off disables them. Change this variable and apply: the application is not redeployed."
  type        = string
  default     = "block"

  validation {
    condition     = contains(["block", "log", "off"], var.mode)
    error_message = "mode must be block, log or off."
  }
}

variable "managed_rulesets" {
  description = "Managed rulesets to execute, by name to ruleset id. The default is Cloudflare's Free Managed Ruleset; Pro and above add \"cloudflare_managed\" (efb7b8c949ac4650a09736fc376e9aee) and \"owasp\" (4814384a9e5d4991b9815dcfc25d2f1f)."
  type        = map(string)
  default = {
    cloudflare_free = "77454fe2d30c4220b5701f6fdfb893ba"
  }
}

variable "blocked_methods" {
  description = "HTTP methods refused on the API and relay hosts."
  type        = list(string)
  default     = ["TRACE", "TRACK", "CONNECT"]
}
