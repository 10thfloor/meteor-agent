# Security

## Reporting a vulnerability

Please **do not** open a public issue. Use [GitHub private vulnerability
reporting](https://github.com/10thfloor/meteor-agent/security/advisories/new) and
include the affected version, impact, and a minimal reproduction when possible.
Reports are acknowledged privately; coordinated fixes land on `main` before
public details are disclosed.

## Security model

- **Client writes are denied on every package collection.** This covers the
  session, message, delta, memory, attachment, download-token, channel-binding,
  channel-identity, delivery-receipt, inbound-submission, link-token, and
  verdict-token stores. Legitimate writes use checked server methods with
  session authorization.
- **Anonymous sessions are bearer capabilities.** Knowing an anonymous session
  id grants access to that session, so ids must not appear in logs or analytics.
  Anonymous sessions cannot be listed by anonymous callers.
- **Channel webhooks authenticate before use.** Slack, WhatsApp, Twilio, and
  Telegram requests are verified with their provider-specific mechanism before
  state changes; request bodies are capped and stable provider event ids are
  admitted once. Email uses a constant-time checked Basic-auth credential and
  should also be protected by an edge IP allowlist.
- **Linking is completed from the authenticated side.** Single-use expiring
  tokens connect an external identity to an account; provider profile data is
  not sufficient by itself.
- **Secrets belong in `Meteor.settings` or the environment.** `settings.json`
  is ignored and `settings.example.json` contains placeholders only.

## Release hygiene

Create release archives from tracked Git, using `git archive` or a clean
checkout. Never distribute a tarball of a working directory: ignored files such
as `settings.json` and `.meteor/local` can contain credentials, transcripts,
MongoDB data, or build artifacts that do not belong in a release.

## Data retention

Retention is host-managed. Package-owned durable data includes sessions,
committed messages, memories, channel bindings and identities, delivery
receipts, and attachment metadata and bytes; these remain until the host
application removes them. Streaming deltas live in a capped collection and are
discarded as turns commit. Inbound submission deduplication rows expire after
seven days. Link, verdict, and download tokens carry short expiries and are
TTL-reaped. Attachment bytes are retained by default; set
`Meteor.settings.packages['10thfloor:agent'].attachments.retentionDays` to a
positive value to create a TTL policy. Memory entries expire only when the app
sets an expiry.

## Scope

The core and channel packages are the product. `app/` is a demo and test host;
its account setup is not a production identity reference.
