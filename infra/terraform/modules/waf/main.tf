# Edge rules in front of the API and relay (B097). Rule order matters: every ruleset starts with
# the availability skip, so a rule below it can never block /healthz, /readyz or /v1/status, and the
# relay hosts accept the WebSocket path(s) in var.ws_paths and nothing else.

locals {
  hosts = concat([var.api_hostname], var.relay_hostnames)

  host_set         = "{${join(" ", [for h in local.hosts : "\"${h}\""])}}"
  relay_host_set   = "{${join(" ", [for h in var.relay_hostnames : "\"${h}\""])}}"
  availability_set = "{${join(" ", [for p in var.availability_paths : "\"${p}\""])}}"
  ws_set           = "{${join(" ", [for p in var.ws_paths : "\"${p}\""])}}"
  methods_set      = "{${join(" ", [for m in var.blocked_methods : "\"${m}\""])}}"
  api_host         = "http.host eq \"${var.api_hostname}\""
  on_our_hosts     = "http.host in ${local.host_set}"
  not_availability = "not http.request.uri.path in ${local.availability_set}"
  enabled          = var.mode != "off"
  action           = var.mode == "log" ? "log" : "block"

  # No Authorization header: the "anonymous" bucket of CT-PAGE.
  anonymous = "len(http.request.headers[\"authorization\"]) eq 0"
}

# 1. Custom rules: skip for availability paths, then the refusals.
resource "cloudflare_ruleset" "custom" {
  zone_id     = var.zone_id
  name        = "centcom custom rules"
  description = "Availability skip, HTTPS only, blocked methods, relay path allow-list."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "availability_skip"
      description = "Never block health checks or the status endpoint"
      expression  = "${local.on_our_hosts} and http.request.uri.path in ${local.availability_set}"
      action      = "skip"
      action_parameters = {
        ruleset = "current"
      }
      logging = {
        enabled = true
      }
      enabled = true
    },
    {
      ref         = "https_only"
      description = "Refuse plain HTTP (certificate validation on /.well-known/acme-challenge/ is exempt)"
      expression  = "${local.on_our_hosts} and not ssl and not starts_with(http.request.uri.path, \"/.well-known/acme-challenge/\")"
      action      = local.action
      enabled     = local.enabled
    },
    {
      ref         = "blocked_methods"
      description = "TRACE, TRACK and CONNECT are never used"
      expression  = "${local.on_our_hosts} and http.request.method in ${local.methods_set}"
      action      = local.action
      enabled     = local.enabled
    },
    {
      ref         = "relay_paths"
      description = "The relay hosts serve the WebSocket path and health checks only"
      expression  = "http.host in ${local.relay_host_set} and not http.request.uri.path in ${local.ws_set}"
      action      = local.action
      enabled     = local.enabled
    },
  ]
}

# 2. Managed rulesets, after the same availability skip.
resource "cloudflare_ruleset" "managed" {
  zone_id     = var.zone_id
  name        = "centcom managed rulesets"
  description = "Cloudflare managed rulesets on the API and relay hosts."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = concat(
    [
      {
        ref         = "availability_skip"
        description = "Never block health checks or the status endpoint"
        expression  = "${local.on_our_hosts} and http.request.uri.path in ${local.availability_set}"
        action      = "skip"
        action_parameters = {
          ruleset = "current"
        }
        enabled = true
      },
    ],
    [
      for name, id in var.managed_rulesets : {
        ref         = "managed_${name}"
        description = "Execute ${name}"
        expression  = local.on_our_hosts
        action      = "execute"
        action_parameters = {
          id = id
        }
        enabled = local.enabled
      }
    ],
  )
}

# 3. Rate limits per client address, mirroring CT-PAGE (anonymous 30/min, auth endpoints 20/min).
resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.zone_id
  name        = "centcom rate limits"
  description = "Per-IP limits in front of the application's own limiter (B023)."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      ref         = "auth_endpoints"
      description = "Sign-in and token endpoints, per client address"
      expression  = "${local.api_host} and starts_with(http.request.uri.path, \"/v1/auth/\") and ${local.not_availability}"
      action      = local.action
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = var.rate_limits.period_s
        requests_per_period = var.rate_limits.auth_per_period
        mitigation_timeout  = var.rate_limits.mitigation_timeout_s
      }
      enabled = local.enabled
    },
    {
      ref         = "anonymous"
      description = "Requests without credentials, per client address"
      expression  = "${local.api_host} and ${local.anonymous} and ${local.not_availability} and not starts_with(http.request.uri.path, \"/v1/auth/\")"
      action      = local.action
      ratelimit = {
        characteristics     = ["ip.src", "cf.colo.id"]
        period              = var.rate_limits.period_s
        requests_per_period = var.rate_limits.anonymous_per_period
        mitigation_timeout  = var.rate_limits.mitigation_timeout_s
      }
      enabled = local.enabled
    },
  ]
}
