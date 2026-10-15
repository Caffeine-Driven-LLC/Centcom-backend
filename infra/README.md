# Infrastructure

Two ways to run Centcom live here. They do not share code:

- **One small server** (`infra/deploy/`, `docs/ops/deployment.md`): Docker Compose and Caddy on one
  machine. This is what runs today.
- **Fly.io and Cloudflare, three environments** (this file, `infra/terraform/`, `infra/fly/`): the
  multi-region design of lane B091. Nothing here has been applied to a real account yet.

## What Terraform manages, and what it does not

| Terraform (`infra/terraform/envs/<env>`)                                                                | `fly deploy` (`infra/fly/fly.<service>.<env>.toml`, lane B092)        |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Fly apps `centcom-<env>-api`, `-relay`, `-worker`, `-admin`, `-db`, `-redis`                            | Machines of api, relay, worker and admin: image, regions, size, count |
| IP addresses and TLS certificates of the public apps (api, relay); none for admin                       | Health checks (`/healthz`, `/readyz`), `kill_timeout`, HTTPS redirect |
| Postgres 16 machines and volumes (a replica in the second region when `postgres_ha`), Redis with an AOF | Release command and migrations                                        |
| Five private R2 buckets with lifecycle rules, and a 30-day lock on `backups`                            |                                                                       |
| DNS records for `api`, `releases` and `relay-<region>` host names                                       |                                                                       |

Sizes, regions and counts have one source: `infra/terraform/envs/<env>/terraform.tfvars.json`.
`node infra/fly/gen.mjs` (`pnpm infra:fly`) copies them into the Fly files; a test fails when the two
differ.

| Environment | Topology                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| dev         | One machine per service in `iad`, 1 shared CPU and at most 512 MB, one Postgres machine, no replica  |
| stage       | The topology of prod (2 regions, Postgres with a replica) at about a quarter of the size             |
| prod        | api 3 machines in `iad` and `fra`, relay 2 per region in both, worker 2, Postgres HA, Redis with AOF |

Each environment has its own Fly organisation, its own Terraform state bucket and key, its own R2
buckets and its own tokens and passwords. Nothing is shared.

## Commands

```
pnpm infra:check            terraform fmt, validate (3 roots), tflint, checkov (needs Docker)
pnpm infra:plan -- dev      terraform plan (needs terraform and the credentials below)
pnpm infra:apply -- dev     terraform apply; prod needs CI=true and a saved plan file
pnpm infra:fly              regenerate infra/fly/fly.*.toml from the tfvars
pnpm test                   includes infra/terraform/envs.test.ts (policy tests over committed plans)
node infra/terraform/tests/gen-plan.mjs   regenerate the committed plans after changing a .tf or tfvars file
```

Credentials are environment variables of whoever runs Terraform: `FLY_API_TOKEN`,
`CLOUDFLARE_API_TOKEN`, and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (an R2 API token) for the
state bucket. Secret values for the apps are set with `fly secrets set`; their names are in
[`fly/SECRETS.md`](fly/SECRETS.md).

## Bootstrap order (once per environment, by the owner)

1. Create the Fly organisation `centcom-<env>` and a Cloudflare zone for the domain.
2. Create the state bucket `centcom-<env>-tfstate` in R2 by hand (it cannot hold its own creation),
   and an R2 API token for it. Put the account id in `envs/<env>/backend.hcl`, and the real account
   and zone ids, organisation and domain in `envs/<env>/terraform.tfvars.json`. The ids are
   identifiers, not credentials; the files hold placeholders until then.
3. `pnpm infra:plan -- dev`, review, `pnpm infra:apply -- dev`. Run `plan` again: it must show no changes.
4. Set the Fly secrets, then deploy the apps (B092).
5. Stage the same way. Prod is applied from CI with a saved plan that a human approved.

## Break-glass

- **State lock held after a crash:** only the owner runs `terraform force-unlock <id>` in the
  environment's root, after checking that no apply is running. CI never force-unlocks. With the S3
  lock file the lock is the object `<env>/terraform.tfstate.tflock` in the state bucket.
- **Partial apply:** every resource is idempotent; run `plan` and `apply` again.
- **Moving a relay region:** change `regions_relay` in the tfvars. The data layer is not touched.
- **Provider rate limits:** re-run the apply; Terraform resumes where it stopped.

## Open decisions

- The Postgres and Redis provider is open (the card's ADR): this design runs both on Fly machines
  through `modules/postgres` and `modules/redis`, whose outputs (`url_secret_name`, `host`, `ha`) hide
  the choice. File the ADR before prod.
- Backups, PITR and the WAF belong to B099 and B097 and plug in beside these modules
  (`modules/backup/`, `modules/waf/`).
