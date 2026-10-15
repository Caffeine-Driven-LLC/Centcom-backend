output "hostnames" {
  value = sort(keys(cloudflare_dns_record.cname))
}
