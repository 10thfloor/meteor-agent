# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email the
maintainer (the address on the commits) with a description and, if you can, a
minimal reproduction. You'll get an acknowledgement within a few days; fixes
land on `main` and are noted in the commit message.

## What to expect from the code

- **Client writes are denied on every collection** (the three core ones and
  the six channel ones), so Meteor's `insecure` package grants nothing even if
  a host app still has it installed. All legitimate writes go through server
  methods with `check()`-validated arguments and per-session ownership checks.
- **Anonymous sessions are capability-URLs**: knowing a session id is the
  credential, and such sessions are deliberately non-enumerable (the list
  publication returns nothing to an anonymous caller).
- **Channel webhooks verify the provider's signature first** (Slack v0 HMAC
  with a replay window, WhatsApp `X-Hub-Signature-256`, Twilio HMAC-SHA1 over
  URL + params, Telegram `secret_token`), in constant time, before any state
  is touched; request bodies are size-capped before verification; every
  provider event is admitted exactly once by its redelivery-stable id.
- **Account linking completes only from the authenticated side** with
  single-use, expiring, unguessable tokens; an external identity is never
  trusted by itself, and a profile email is never auto-linked.
- **Secrets live in `Meteor.settings` / the environment**, never in the
  repo — `settings.json` is git-ignored and `settings.example.json` carries
  placeholders only.

## Scope

The package (`app/packages/agent`) and the channel packages
(`app/packages/agent-channel-*`) are the product. `app/` is a demo host app
and test harness — treat its accounts setup as a demo, not a reference for
production identity.
