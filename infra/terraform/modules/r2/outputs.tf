output "bucket_names" {
  description = "Bucket name by purpose."
  value       = { for k, b in cloudflare_r2_bucket.this : k => b.name }
}
