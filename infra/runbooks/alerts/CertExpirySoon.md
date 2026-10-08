# CertExpirySoon

Severity: `ticket` · Service: `platform` · Owner: `platform` · Metric:
`probe_ssl_earliest_cert_expiry` (blackbox_exporter, `job="tls"`, see
[exporters.yaml](../../alerts/exporters.yaml)) · Rules:
[platform.rules.yaml](../../alerts/rules/platform.rules.yaml)

## Symptoms

A TLS certificate served by one of our endpoints (`instance` names it: `api`, `relay-<region>` or
`releases` hosts, B091) expires in less than 14 days. Certificates normally renew automatically
30 days before expiry, so renewal has failed.

## Impact

None yet. On expiry every client refuses the endpoint: the API, a relay region or downloads stop
working for everyone.

## Dashboards

- `$GRAFANA/d/centcom-api-overview?var-env=$ENV` shows traffic to the API host; the certificate
  itself is in the query below.

## Triage commands

1. Which host and when (Grafana Explore):
   `(min by (instance) (probe_ssl_earliest_cert_expiry{env="$ENV", job="tls"}) - time()) / 86400`
   gives days left.
2. What the host serves: `openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -issuer -enddate`.
3. Why renewal failed: `fly certs show <host> -a centcom-$ENV-<service>` (Fly-managed
   certificates), or the DNS provider's certificate page (B091's DNS module).

## Mitigation

- Fly-managed: fix what blocks validation (usually a DNS record that changed), then
  `fly certs check <host> -a centcom-$ENV-<service>` to retry.
- Elsewhere: renew or re-issue at the provider before the expiry date.

## Escalation

A ticket for the platform team. Raise it to the primary on-call when fewer than 3 days are left.

## Verification

`(min by (instance) (probe_ssl_earliest_cert_expiry{env="$ENV", job="tls"}) - time()) / 86400`
shows more than 60 days for the host, and
`openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -enddate`
shows the new end date.

## Post-incident

Record why renewal failed and make it automatic again; a manual renewal will be forgotten.
