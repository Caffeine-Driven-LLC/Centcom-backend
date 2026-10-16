resource "cloudflare_dns_record" "cname" {
  for_each = var.records

  zone_id = var.zone_id
  name    = each.key
  type    = "CNAME"
  content = each.value
  proxied = var.proxied
  ttl     = 1
  comment = "Managed by Terraform (B091)"
}
