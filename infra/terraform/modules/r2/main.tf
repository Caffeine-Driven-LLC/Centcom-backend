# Object storage. Every bucket is private: no public r2.dev domain and no custom domain. Objects are
# encrypted at rest by R2 itself. Downloads go through the API (presigned URLs), including the
# `releases` host name, which points at the API app (see the dns module).

locals {
  day_seconds = 86400
}

resource "cloudflare_r2_bucket" "this" {
  for_each = var.buckets

  account_id = var.account_id
  name       = "centcom-${var.env}-${each.key}"
  location   = var.location
}

# The public r2.dev address is the only way to expose a bucket without a custom domain; it stays off.
resource "cloudflare_r2_managed_domain" "off" {
  for_each = var.buckets

  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this[each.key].name
  enabled     = false
}

resource "cloudflare_r2_bucket_lifecycle" "this" {
  for_each = var.buckets

  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this[each.key].name

  rules = concat(
    [{
      id      = "abort-stale-uploads"
      enabled = true
      conditions = {
        prefix = ""
      }
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 7 * local.day_seconds
        }
      }
    }],
    each.value.delete_after_days == null ? [] : [{
      id      = "expire-objects"
      enabled = true
      conditions = {
        prefix = ""
      }
      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = each.value.delete_after_days * local.day_seconds
        }
      }
    }],
  )
}

# Objects in a locked bucket cannot be overwritten or deleted until they are lock_days old.
resource "cloudflare_r2_bucket_lock" "this" {
  for_each = { for k, b in var.buckets : k => b if b.lock_days != null }

  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.this[each.key].name

  rules = [{
    id      = "retain-${each.value.lock_days}-days"
    enabled = true
    prefix  = ""
    condition = {
      type            = "Age"
      max_age_seconds = each.value.lock_days * local.day_seconds
    }
  }]
}
