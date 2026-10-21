# Proposal: confirm an account deletion with a recent sign-in

Status: proposal, needs a Contract PR (`contracts/` is read-only for lanes, GUIDELINES §2.1).

## Today

`DELETE /v1/me` (CT-API-ACCOUNTS) takes no body and no confirmation: any valid access token with scope `profile` starts the 30-day
grace period. A stolen or left-open session can therefore start a deletion. The impact is bounded: the user is signed out everywhere at
once (so they notice), and `POST /v1/me/restore` ends the deletion for 30 days after a fresh sign-in, which the backend allows for accounts in
their grace period.

## What the backend could do with a contract change

One of:

1. **Fresh sign-in.** `DELETE /v1/me` requires the access token to carry an `auth_time` claim no older than 5 minutes; otherwise 401
   `reauth_required` (new code in `errors.json`) with the sign-in URL. No new body. Needs the token claim (CT-AUTH) and the error code.
2. **Typed confirmation.** The request body carries `{confirm: "<the account's e-mail address>"}`, 422 when it differs. Needs the request
   schema in `openapi.yaml`.
3. **A deletion e-mail.** The request sends a link; the 30 days start when it is used. Needs a new state (`awaiting_confirmation`) in
   `AccountDeletion.status` and a route.

Option 1 is the smallest change and matches how the device-code and magic-link flows already work; option 3 is the strongest.

## Why it is not built

A lane may not invent a request field, a status or an error code the contract does not define. Until the Contract PR lands, the
conservative reading is implemented: the route as the contract describes it, plus the immediate token revocation and the restore path.
