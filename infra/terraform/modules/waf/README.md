# waf: Cloudflare edge rules (B097)

Three zone rulesets in front of the API and relay hosts:

| Ruleset      | Phase                           | Rules                                                                                |
| ------------ | ------------------------------- | ------------------------------------------------------------------------------------ |
| `custom`     | `http_request_firewall_custom`  | availability skip, HTTPS only, blocked methods, relay path allow-list                |
| `managed`    | `http_request_firewall_managed` | availability skip, then each ruleset in `managed_rulesets`                           |
| `rate_limit` | `http_ratelimit`                | auth endpoints 20 per minute per address, requests without credentials 30 per minute |

Every ruleset starts with a skip rule for `/healthz`, `/readyz` and `/v1/status`, and the rate
limits exclude those paths, so no rule here can take the service out of a load balancer's or an
uptime monitor's view. The relay hosts accept only `ws_paths` (default `/v1/ws`) plus the health
checks; the WebSocket upgrade is never blocked on that path.

```hcl
module "waf" {
  source          = "../../modules/waf"
  zone_id         = var.cloudflare_zone_id
  api_hostname    = "api.example.com"
  relay_hostnames = ["relay.example.com"]
}
```

Inputs: `zone_id`, `api_hostname`, `relay_hostnames`, `ws_paths`, `availability_paths`, `rate_limits`,
`mode`, `managed_rulesets`, `blocked_methods`. Outputs: `ruleset_ids`, `rule_ids`.

**False positive?** Set `mode = "log"` (needs an Enterprise plan; otherwise `"off"`) and apply. No
application deploy is involved; the runbook entry is in `docs/security/hardening.md`.

**Plan limits.** The Free plan has one rate-limiting rule with a 10 s period: set
`rate_limits.period_s = 10` and scale the numbers, and drop one of the two rules. Regex matching
(the card's `ws_path_regex`) needs Business, so paths are matched exactly. The Cloudflare and OWASP
managed rulesets are Pro and above (ids in the `managed_rulesets` description).

## Checking it

- `tests/validate.sh`: `terraform fmt -check` and `terraform validate` in a container.
- `waf.test.ts`: policy tests over `tests/fixtures/plan-*.json`, the offline `terraform plan` of
  `tests/plan` with dummy values. After a change to a `.tf` file run
  `node infra/terraform/modules/waf/tests/gen-plan.mjs`; the first test fails on a stale fixture.
- Not checked: that Cloudflare's API accepts these expressions on your plan (a plan against the
  real zone is `terraform plan` with a token).
