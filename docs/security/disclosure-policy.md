# Vulnerability disclosure policy

Lane B098. This is the text for the public page; the web side publishes it and serves
[`security.txt.template`](security.txt.template) as `/.well-known/security.txt`. Both are written here and
**not yet published**. Placeholders in `{{double braces}}` are filled by the owner before they go live, and the
response times below are proposals the owner confirms: they are promises to outsiders.

## If you found a vulnerability

Please tell us before you tell anyone else. Send a report to **{{SECURITY_CONTACT}}** (an address on our own
domain; an encrypted channel is offered in the `security.txt` file when we have a key to publish). Include:

- what you found and where (host, route or feature), and what an attacker gains;
- steps to reproduce, with the smallest request that shows it;
- the account or workspace you used, if any, and the time of the test (UTC);
- your name or handle if you want credit.

We acknowledge within **2 working days**, send a first assessment within **7 days**, and keep you updated at
least every 14 days until the issue is fixed. We aim to fix critical issues within 7 days and others within 90
days. Please give us that time before you publish; if we need longer we will say why. We credit reporters who
want credit, once the fix is released.

## What is in scope

The Centcom backend we operate: the REST API, the WebSocket relay, the sign-in pages, the billing and outgoing
webhook features, and the release manifests we serve. Reports about the encryption design, plaintext reaching
our servers, one workspace reading or changing another's data, minting an identity, or changing another
customer's plan are the most serious.

## What is not

- Third-party services we use (payment, mail, CDN, hosting). Report those to their owners.
- Denial-of-service by volume, spam, social engineering of our staff or customers, and physical attacks.
- Missing best-practice headers on hosts that serve no user data, or findings that need a rooted device or a
  compromised browser.
- Anything found by reading data that is not yours. Stop when you see someone else's data and tell us.

## Safe harbour

If you act in good faith under this policy, we will not start legal action against you and we will not ask a
hosting or law-enforcement party to. Good faith means: you test only accounts you own or that we gave you; you
do not read, change or keep other people's data; you stay under 50 requests per second; you do not degrade the
service; and you report to us first. This policy covers us only: we cannot speak for third parties.

## Private tests by arrangement

A contracted penetration test runs against the dedicated pen-test environment and follows
[`pentest-scope.md`](pentest-scope.md), not this page.

## Our side

Reports are handled by the owner of the security mailbox. Each gets an issue with a severity
([`pentest-scope.md`](pentest-scope.md#severity)), a regression test with the fix, and a line in the release
notes when users must act. The owner reviews this policy every 12 months; the `Expires` date in `security.txt`
is moved at the same time.
