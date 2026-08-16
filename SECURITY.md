# Security policy

Report vulnerabilities privately to `security@press-say.app`. Do not open a
public GitHub issue for a suspected vulnerability.

## Sensitive content

Pressay Cloud must not persist or log:

- dictation or selected text;
- transformation prompts or results;
- audio payloads;
- clipboard contents;
- BYOK provider credentials;
- authorization headers, cookies or tokens.

Cloud transcription and transformation handlers may hold content in memory only
for the duration of the upstream request. Error reporting is restricted to an
opaque operation ID, sizes, durations, provider status classes and Pressay error
codes.

## Secrets

Production secrets live in Vercel environment variables scoped to the smallest
required environment. `.env.local` is ignored. Stripe uses a restricted API key;
provider webhook secrets and entitlement signing keys are independent and
rotatable.

## Dependency reporting

Security updates are handled through reviewed pull requests. Production releases
must pass dependency audit, secret scanning and software bill-of-materials gates.
