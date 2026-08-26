# Deploying an agent-enabled Meteor app to Galaxy

`10thfloor:agent` is a Meteor package, not a separately deployed agent service.
In production, you build your own Meteor application, add the package to that
application, and deploy the application to Galaxy in the normal Meteor way.

This repository also contains `app/`, a reference host used by the package's
test suite and documentation. You may deploy that reference app as a smoke
test, but it is not the application architecture adopters should copy into
production.

| Artifact | Purpose | Production deployment |
| --- | --- | --- |
| Your Meteor application | Owns identity, UI, agents, tools, policy, and data lifecycle | Deploy this to Galaxy |
| `10thfloor:agent` and channel packages | Libraries inside your application | Ship inside the application bundle |
| This repository's `app/` | Reference UI, scripted provider, integration tests, and examples | Optional Galaxy smoke test only |

## 1. Build the host application

Start from a separate Meteor 3.5+ application. A minimal layout might be:

```text
my-app/
├── client/
├── server/
│   └── agents.ts
├── packages/
│   └── agent/                 # vendored until published to Atmosphere
├── deploy/
│   └── galaxy.settings.json   # ignored; never committed
├── .meteor/
└── package.json
```

Until the packages are published to Atmosphere, vendor the core package—and
only the channel packages the application actually uses—following the
[installation instructions](../../README.md#install-in-an-app). Then install
the package and its direct npm dependencies from the host application's root:

```bash
meteor add 10thfloor:agent
meteor npm install --save @earendil-works/pi-ai typebox
meteor remove insecure autopublish
```

Define agents on the server and provide a client experience through
`ClientAgent`, `<agent-chat>`, or the host application's own UI. The host—not
this package—owns login policy, user roles, tool authorization, aggregate
provider spend limits, and durable-data deletion.

Before deploying, exercise the application with `mockProvider` or another
non-billing provider. The package's provider seam is the same on a laptop and
Galaxy, so a mock run verifies the transcript, methods, publications, tools,
and UI without making a model call.

## 2. Prepare Galaxy and MongoDB

The host application needs:

- A Meteor account with access to the intended Galaxy organization.
- Meteor 3.5+, which uses Node 24. Let the Meteor tool and Galaxy select the
  runtime rather than installing another Node version into the application.
- A MongoDB 6+ replica set or sharded cluster in the same region as the Galaxy
  app. Meteor 3.5 uses change streams by default, and the agent relies on
  low-latency reactive observers.
- A Galaxy site name, initially something like `YOUR-APP.meteorapp.com`.

Galaxy's free shared MongoDB can prove the deployment path, but the Meteor CLI
documents that it does not include production backup or restore resources.
Use a production datastore before handling real conversations.

Current upstream references:

- [Meteor deployment guide](https://docs.meteor.com/tutorials/deployment/deployment.html)
- [`meteor deploy` CLI reference](https://docs.meteor.com/cli/#meteor-deploy-site)
- [Meteor production security and Galaxy App
  Protection](https://docs.meteor.com/tutorials/security/security.html)
- [Meteor environment variables](https://docs.meteor.com/cli/environment-variables)

## 3. Create application settings

This repository provides a starting point at
`deploy/galaxy.settings.example.json`. Copy it into the host application's own
deployment directory:

```bash
mkdir -p deploy
cp /path/to/meteor-agent/deploy/galaxy.settings.example.json \
  deploy/galaxy.settings.json
```

Add `deploy/galaxy.settings.json` to the host application's `.gitignore`. Keep
the real file outside the Meteor application's `private/` directory so it does
not become a server asset in the built application.

Edit the two required values under `galaxy.meteor.com.env`:

- `ROOT_URL`: the final HTTPS origin, with no trailing path.
- `MONGO_URL`: the production database URI. Keep the database and Galaxy app
  in the same region and configure its network policy for Galaxy.

The template enables every package DDP rate-limit group and retains attachment
bytes for seven days. Sessions, transcript messages, memories, channel
bindings, and receipts remain host-managed durable data; define their
retention and deletion policy in the application.

Do not put secrets below a `public` key. Galaxy converts entries under
`galaxy.meteor.com.env` into server process environment variables.
Those nested variables are Galaxy configuration; `meteor run --settings ...`
does not export them into a local shell. Set local process variables separately
when a preflight must use the same database or provider credential.

### Model credentials

For an application using one API-key provider, add the generic override inside
`env`. The key must be valid for the provider prefix in the agent's model:

```json
"PROVIDER_API_KEY": "REPLACE_WITH_SECRET"
```

For several providers at once, omit the generic override and use pi-ai's
provider-specific variables:

```json
"ANTHROPIC_API_KEY": "REPLACE_WITH_SECRET",
"OPENAI_API_KEY": "REPLACE_WITH_SECRET"
```

Ambient credentials such as AWS credentials for Bedrock continue through
pi-ai's native resolution. Channel credentials belong in the top-level
`packages["10thfloor:agent"]` object, following the
[reference settings](../../app/settings.example.json) in this repository.

## 4. Run the host application's preflight

Deploy a clean commit that already passed the host application's CI. At a
minimum, from that application's root:

```bash
meteor npm ci
meteor run --settings deploy/galaxy.settings.json
```

Against a local or staging database, verify:

- login and session ownership;
- one mock-backed agent conversation;
- a read-only tool and an approval-gated tool;
- reconnecting to an existing transcript;
- the application's deletion/retention path.

Run the application's typecheck, tests, and production build as applicable.
When developing the package itself, this repository additionally uses:

```bash
npm --prefix app run typecheck
npm --prefix app run types:check
npm --prefix app test
./scripts/verify-build.sh
```

The final command verifies pi-ai, TypeBox, and the MCP SDK from Meteor's
relocated production `node_modules` tree rather than the development layout.

## 5. Deploy the host application

Authenticate once and confirm the Meteor account:

```bash
meteor login
meteor whoami
```

Run the deployment from the root of the separate Meteor application—not from
this package repository. The current US Galaxy deployment hostname is shown
below; use the hostname for the selected Galaxy region when deploying
elsewhere.

```bash
cd /path/to/my-app
DEPLOY_HOSTNAME=us-east-1.galaxy-deploy.meteor.com \
  meteor deploy YOUR-APP.meteorapp.com \
  --owner YOUR-GALAXY-OWNER \
  --settings deploy/galaxy.settings.json
```

Omit `--owner` only when the app should belong to the logged-in personal
account. Do not use `--debug` for production.

For a disposable smoke test, Galaxy supports `--free --mongo`. Its one Tiny
container cold-starts after inactivity, and its shared database is not a
production datastore. The tracked settings template intentionally describes
the production-shaped external-Mongo path instead.

## 6. Verify the host application

In Galaxy and the deployed application:

1. Confirm the deployment reached a healthy container without repeated
   restarts.
2. Test login, create an owned session, and complete the same mock-provider
   flow used during preflight.
3. Check startup logs for index-creation warnings. If the MongoDB user cannot
   create indexes, provision the indexes listed in the package README before
   adding traffic.
4. Confirm MongoDB is using change streams rather than polling. A roughly
   ten-second streaming cadence indicates a standalone or otherwise
   incompatible MongoDB deployment.
5. Enable **Force HTTPS** for the domain in Galaxy's Domains & Encryption
   settings before issuing login, channel-link, or approval URLs.
6. Inspect memory, CPU, restarts, connections, and MongoDB connection counts
   during a short concurrent-chat test before changing container size or
   autoscaling rules.
7. Introduce one live model credential and verify one inexpensive turn through
   an authenticated, budgeted agent before widening access.

Never print the settings file or raw provider errors containing credentials
into CI or application logs.

## Optional: deploy this repository's reference app

The reference app under `app/` is useful when the question is narrowly “does
the package work on Galaxy?” It provides:

- the `<agent-chat>` reference UI;
- a `demo` agent;
- a scripted provider requiring no credential;
- a `clock` tool and an approval-gated fake `refund` tool;
- optional examples for the five channel packages.

Without `PROVIDER_API_KEY` or `ANTHROPIC_API_KEY`, it cannot incur model spend.
Its refund tool explicitly performs no real action. Deploying it verifies the
Galaxy build, MongoDB reactivity, DDP streaming, tools, and approvals, but does
not validate a production application's identity or authorization model.

To smoke-test it, populate this repository's ignored
`deploy/galaxy.settings.json`, then deploy from `app/`:

```bash
cd app
DEPLOY_HOSTNAME=us-east-1.galaxy-deploy.meteor.com \
  meteor deploy YOUR-SMOKE-APP.meteorapp.com \
  --owner YOUR-GALAXY-OWNER \
  --settings ../deploy/galaxy.settings.json
```

After deployment, send `what time is it?` and complete the `refund my order`
approval flow. Delete the smoke deployment and its database when the platform
check is complete. Do not evolve the reference app into the product
application; start that application separately and consume the package.

## Scaling and rolling deploys

Start with one appropriately sized container and measure. The harness is safe
to scale horizontally: every container may run the orphan watcher and channel
delivery worker, while MongoDB leases and conditional claims select one
winner. No designated worker container is required by default.

Galaxy performs rolling deployments, so old and new application versions
overlap briefly. Keep persisted document changes backward-compatible across
one release boundary. If a future release needs a destructive migration, use
expand/migrate/contract deployments rather than coupling it to one code push.

To roll back code, redeploy the application's last known-good Git tag with the
same settings. Rolling back code does not roll back MongoDB data; evaluate data
compatibility first.

## Before public live traffic

- Require authentication, or deliberately design and review an anonymous
  bearer-capability application.
- Give every live agent a per-session `budget`.
- Keep all six package DDP rate-limit groups configured.
- Add a fleet-wide model spend kill switch or quota. Galaxy App Protection is
  complementary, not a DDP spend control.
- Define durable-data deletion, retention, and backup policies.
- Rotate any credential that passed through an unsafe staging channel.
- Configure alerts for container restarts, memory pressure, error logs, and
  provider spend.

CI deployment should come after the manual path is proven. Meteor supports a
`METEOR_SESSION_FILE` for non-interactive deploys; store that file and the
complete settings JSON as protected CI secrets, never in the repository.
