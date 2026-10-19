# Evaluation Lab and local federation

Constellation adds two application surfaces on top of meteor-agent: repeatable
Agent evaluations and a revocable local MCP endpoint. Both are disabled from
ordinary Agent conversations unless a workspace owner uses their control-panel
UI.

## Evaluation Lab

An evaluation dataset is a named collection of scenarios. Every saved dataset
and scenario change receives a monotonically increasing revision, and an
immutable server-only version row is retained. Starting an experiment freezes
the dataset revision, full scenario revisions, and each selected Crew
configuration revision/model before any model runs. Every cell rechecks that
the Agent is still active and unchanged before and after provider work; an edit
becomes an explicit error result instead of silently mixing configurations.
Each result records the exact scenario revision, Crew configuration revision,
configured and resolved model, Agent definition version, response, selected
Tool names, duration, usage, and individual scores.

The built-in deterministic gates are:

- `contains`: every phrase must occur, compared case-insensitively after Unicode
  normalization;
- `avoids`: no listed phrase may occur;
- `requiredTool`: the model must select the named Tool.

Applications can install bounded custom or model-based scorers through
`EvaluationScorerDefinition`. A scorer returns a normalized score, pass/fail,
and a short reason. A failing scorer is recorded as a failed score and does not
erase the other results in the experiment. Hooks have a bounded timeout and an
abort signal for cooperative cancellation.

### Isolation boundary

Evaluation runs use the Agent's current model, base instructions, Skills, and
Tool schemas. They run in a non-enumerable, archived, ephemeral Session that is
erased before its result is accepted. The evaluation config explicitly removes
live Identity, Constitution, Fact Memory, Experience, and Practice state.

**Tools are simulated.** The model sees their schemas and can select them, but
`canUse` denies every dispatch before its implementation. This makes a required
Tool gate useful without letting a benchmark publish, send, write, delegate, or
call an MCP server. Tool arguments and Tool results are not persisted in the
evaluation result.

Scenarios may optionally include immutable synthetic `fixtures` for facts,
experiences, practices, and constitution text. Fixtures let a test exercise
memory-shaped behavior without consulting or changing the live Agent. They are
ordinary prompt context; they do not measure retrieval quality, consolidation,
Experience capture, or Practice promotion. Testing those behaviors will require
a future disposable store seeded from an explicit snapshot.

Current limitations:

- phrase gates measure exact normalized substrings, not semantic equivalence;
- custom/model scorers are developer-registered hooks, not created in the UI;
- cells within an experiment run serially, and each workspace may run at most
  two experiments concurrently, to bound local-model and model-judge load;
- Agent edits do not mutate an existing experiment: an edited or disabled Agent
  fails its remaining cells and the user can run the pinned scenario set again;
- cancellation is cooperative at cell boundaries; an in-flight provider call
  may finish but its result is discarded, while scorer hooks receive an abort
  signal and should honor it;
- runs left in progress by an app restart are closed as interrupted failures
  instead of remaining in a permanent loading state;
- live memory and learning are intentionally out of scope for this isolation
  mode.

## Local MCP federation

The MCP server is mounted at `/constellation/mcp` using stateless Streamable
HTTP JSON-RPC. The published configuration provides the absolute local URL.
It is unavailable until the workspace owner creates a token, selects at least one
active Agent or Mission, and enables sharing.

Security properties:

- requests are accepted only from a socket loopback address;
- access uses a random 256-bit bearer token; only its SHA-256 hash and a
  six-character display hint are stored;
- the plaintext token is returned once, when it is created or replaced;
- replacing or revoking the token takes effect on the next request;
- enabled state, token generation, workspace ownership, selected targets, and
  target liveness are read again immediately before `tools/call` invokes work;
- unselected or archived Agents and inactive Missions are omitted and cannot be
  called by guessing a Tool name;
- MCP exposes no approval, token, configuration, archive, or other privilege
  management Tool.

Selected Agents appear as `ask_*` Tools and selected active Missions as
`continue_*` Tools. The framework's normal Agent/Mission provider fences and
Tool authorization still apply inside those calls. In particular, an external
MCP caller cannot approve a parked consequential Tool.

This is a local integration boundary, not a remote deployment surface. There is
no TLS, organization identity exchange, OAuth discovery, remote ingress, or
cross-Constellation trust negotiation in this release. Those require an
explicit transport and trust design rather than binding this endpoint beyond
loopback.

## MCP resources and prompts client

meteor-agent's MCP client also supports paginated `resources/list`,
`resources/read`, `prompts/list`, and `prompts/get`. Constellation exposes these
through its existing owner-scoped MCP server inspector.

Every page and content read re-checks the current server authorization. Catalog
metadata is copied through a fixed allowlist, text is bounded, unsafe control
characters are removed, and binary resource/image/audio bytes are represented
as omitted rather than sent through DDP. Resource and prompt failures are
structured and sanitized in the same way as MCP Tool failures.
