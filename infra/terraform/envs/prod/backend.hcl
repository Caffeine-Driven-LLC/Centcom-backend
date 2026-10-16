# Not a secret: the bucket and the S3 endpoint of this environment's state. Replace the account id
# once. Credentials come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (an R2 API token).
bucket    = "centcom-prod-tfstate"
endpoints = { s3 = "https://REPLACE_WITH_ACCOUNT_ID.r2.cloudflarestorage.com" }
