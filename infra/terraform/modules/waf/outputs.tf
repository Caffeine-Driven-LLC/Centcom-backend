output "ruleset_ids" {
  description = "Ids of the three rulesets, by phase."
  value = {
    custom     = cloudflare_ruleset.custom.id
    managed    = cloudflare_ruleset.managed.id
    rate_limit = cloudflare_ruleset.rate_limit.id
  }
}

output "rule_ids" {
  description = "Rule ids by ruleset and ref, for the dashboard and for incident notes."
  value = {
    custom     = { for r in cloudflare_ruleset.custom.rules : r.ref => r.id }
    managed    = { for r in cloudflare_ruleset.managed.rules : r.ref => r.id }
    rate_limit = { for r in cloudflare_ruleset.rate_limit.rules : r.ref => r.id }
  }
}
