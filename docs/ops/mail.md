# Production mail (sign-in codes and invites)

E-mail sign-in links and workspace invites go through one path:

```
 API  ──queue (BullMQ "email-send", Redis)──►  worker  ──►  Resend | Brevo | Postmark | SMTP
```

The API checks and renders the mail, applies the per-recipient limit (5 per hour per template) and
queues it. The worker delivers it with the provider named by `EMAIL_PROVIDER`, retries up to five
times with backoff (the provider's `Retry-After` wins), and dead-letters it after that. A mail
rejected for good (a 4xx from the provider, an SMTP 5xx) is not retried. A job BullMQ hands out
twice sends once (the delivered job id is remembered for 24 hours).

**E-mail sign-in is on only when `EMAIL_PROVIDER` is `resend`, `brevo`, `postmark` or `smtp`.**
With `console` (the default) or `memory` nobody can sign in by e-mail and invites are off.
`DEV_MAILPIT_URL` (local drills) still wins when set.

## Settings

| Key                     | Provider | Meaning                                                               |
| ----------------------- | -------- | --------------------------------------------------------------------- |
| `EMAIL_PROVIDER`        | all      | `resend`, `brevo`, `postmark`, `smtp` (real); `console`, `memory`     |
| `EMAIL_FROM`            | all      | `Centcom <no-reply@your-domain>`; the domain must be verified (below) |
| `EMAIL_TIMEOUT_MS`      | all      | longest wait for one provider call (default 10000)                    |
| `RESEND_API_KEY`        | resend   | API key with "Sending access" only                                    |
| `BREVO_API_KEY`         | brevo    | v3 API key (SMTP & API section)                                       |
| `POSTMARK_SERVER_TOKEN` | postmark | server token                                                          |
| `SMTP_HOST`             | smtp     | server name                                                           |
| `SMTP_PORT`             | smtp     | 587 (starttls, default), 465 (tls), 25 (none)                         |
| `SMTP_SECURE`           | smtp     | `starttls` (upgrade is required, else the send fails), `tls`, `none`  |
| `SMTP_USER`/`PASSWORD`  | smtp     | together; turn on AUTH PLAIN, only ever sent after encryption         |

`infra/deploy/production.env.example` lists all of them; `gen-env.mjs` copies them into
`production.env`. The API and the worker both read them (the compose file passes them to both).
Keys are `Secret`s: they appear in no log line, error or health output. Provider error text is
never kept (it can quote the recipient); only the HTTP or SMTP status is logged.

`SMTP_SECURE=none` sends the password and the mail in clear text. Use it only for a relay on the same
machine or private network.

## What a human must do (cannot be done from the repo)

1. **Create the account** at the provider and an API key (or SMTP credentials).
2. **Verify the sending domain.** In the provider's dashboard add the domain used in `EMAIL_FROM`; it
   shows the DNS records. Add them at your DNS host (Cloudflare):
   - **SPF** (TXT on the sending domain, or on the provider's bounce sub-domain): the provider's
     `include:` entry, such as `v=spf1 include:amazonses.com ~all` (Resend), `include:spf.brevo.com`
     (Brevo), `include:spf.mtasv.net` (Postmark). If SPF already exists, add the `include:` to it;
     there must be exactly one SPF record.
   - **DKIM** (TXT or CNAME records, the provider gives name and value): the provider signs each mail;
     wait until the dashboard says "verified".
   - **DMARC** (TXT on `_dmarc.your-domain`): start with `v=DMARC1; p=none; rua=mailto:dmarc@your-domain`,
     read the reports for two weeks, then move to `p=quarantine`.
   - Optional: a custom return-path / tracking domain if the provider offers one; turn click and open
     tracking **off** (Centcom's mails carry one-time links; the providers' own wrappers would break
     them. The built-in providers already ask for no tracking where the API allows it).
3. Put `EMAIL_PROVIDER`, `EMAIL_FROM` and the key into `infra/deploy/production.env`, then
   `infra/deploy/deploy.sh <tag>` (API and worker restart).
4. **Test** with your own address: ask for a sign-in link from the web app or `centcom login`, check
   the inbox, then the message's "show original": `spf=pass`, `dkim=pass`, `dmarc=pass`.
5. Watch `email_sent_total`, `email_rejected_total` and `email_failed_total` (see
   [observability](observability.md)); a rising `email_failed_total` means mail is going nowhere.

## What is verified, and what is not

Tested in the repo (`packages/core/test/email/providers-more.test.ts`,
`apps/api/test/entrypoint/production-mail.test.ts`): the request each provider makes, the permanent
and retryable split, timeouts, that no key or recipient reaches an error, the SMTP dialogue against a
fake server in plain, STARTTLS and implicit-TLS modes (AUTH PLAIN, dot-stuffing, a refused STARTTLS
never leaks the password), the configuration rules, and the whole queue-then-deliver path against a
local stand-in of Resend.

**Not** verified against a real provider: nobody in this repo has an account. The request shapes
follow each provider's public API documentation (Resend `POST /emails`, Brevo `POST /v3/smtp/email`),
so the first real send is the first live proof. Do step 4 before announcing sign-in.
