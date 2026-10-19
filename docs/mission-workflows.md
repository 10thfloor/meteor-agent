# Mission workflows

Constellation's **Plan** control saves a versioned sequence or graph of work for
one Mission. **Run plan** creates a durable run with step results, live state,
approval checkpoints, and conversation links. Editing the plan affects later
runs. Each existing run retains the definition it started with.

## Plans in mission chat

Choose **Plans** in the composer, or type **#**, to find an accessible saved plan.
The anchored chooser lists this mission first and other missions below. Select
a row to attach a named plan chip above your draft; remove it with its close
button. **Send** shares attached plans as context, even with an empty draft or
a draft containing only “Run”; attaching a plan never executes it.

Choose **Preview** beside a plan, or click an attached chip, to inspect its saved
steps, assignments and version. **Run plan** explicitly starts that version and
preserves your unfinished message and any other attachments. **Open plan** opens
the full editor without changing the chat's mission. Closing it returns focus
to the composer controls. Changed versions require an explicit **Use version**
choice before running. A failed launch preserves its key for a safe retry.

Run cards appear chronologically in the conversation. Completed runs collapse
to a short result; active work has a compact progress rail above the composer.
The rail prioritizes pending review and exposes all active runs. **Review result**
opens the checkpoint question and its source results before approval controls
are shown. Disclosure, keyboard focus and reader-owned scroll survive updates.

The readable handle is assigned when a plan is saved (older plans are backfilled)
and remains stable when its name changes. Duplicate names get distinct handles.
Typed commands remain available as shortcuts:

- `Run #launch-review` starts that saved plan. `Run this mission's plan` starts
  the saved plan belonging to the current mission.
- `@operator review #launch-review before we run it` discusses the selected plan;
  mentioning it does not start the saved plan. Agents receive a bounded, read-only
  snapshot of its saved instructions, assignments and limits, not just its name.
  Context enters through the framework's request hook before auditing and
  protected-memory-frame handling, with a total 12,000-character bound.
- **Note** always adds conversation context without starting a plan or waking
  an agent, even if its text says `Run #launch-review`.

Only those complete run commands execute; conditional requests, questions,
quoted commands and multi-action messages remain conversation. Selected
references pin the saved version. If the plan changes before sending, the app
asks the user to select its current reference rather than silently running a
newer version. Manually typed handles resolve the currently saved version at
submission.

A plan referenced from another mission runs in **its original mission**, with
that mission's Crew, limits and approvals. A public run link records the origin
chat, so progress and review requests can appear where it was launched without
moving or broadening the plan's authority. Both launch controls enter the same
revision-checked workflow engine. Repeating a send key returns the same run;
the existing transactional chat method records the actual user message once,
without a second model turn or JSON in the conversation.

The host's private chat-request ledger preserves the selected snapshots and
launch correlation. Interrupted run submissions can recover using the same
idempotent key; an authority/version failure never becomes a delayed automatic
launch after settings change. Deleting either the source chat or a referenced
mission removes those host snapshots. Listings, publications and provider
context exclude missing or erasing mission roots and other accounts' plans.

## Coordination

| Selection | Execution |
| --- | --- |
| Follow these steps | A step starts after its selected dependencies finish. Independent steps can run concurrently. |
| Coordinator + specialists | The first step plans, middle steps work independently from the plan, and the final step combines their results. |
| Pass between specialists | Each step receives the preceding step's result. |
| Independent reviews + synthesis | Every step except the last runs independently. The last step receives all results. |

A review checkpoint waits for the workspace owner. Approving a checkpoint does
not approve tools the agent might subsequently request. Those requests continue
through the existing conversation approval card, bound to the exact tool call.

## Framework API

`WorkflowEngine` is a server-side registry and durable graph executor. A host
must supply live owner and participant authorization. Each registered primitive
has a name, immutable version, input JSON Schema, optional output JSON Schema,
execution function, and explicit replay policy. Definitions contain data only;
they cannot import or evaluate application code.

```ts
const workflows = new WorkflowEngine({
  namespace: 'myapp',
  authorize: (userId, missionId, step) => canRun(userId, missionId, step),
});

workflows.register({
  name: 'countRecords', version: 1, label: 'Count records', replay: 'safe',
  inputSchema: {
    type: 'object', properties: { collection: { type: 'string' } },
    required: ['collection'], additionalProperties: false,
  },
  outputSchema: { type: 'integer' },
  async execute(input, context) {
    await context.assertActive();
    const count = await countAuthorizedRecords(context.userId, input.collection);
    return { output: count, summary: `${count} records` };
  },
});
```

`start` accepts an owner, Mission ID, validated definition and caller request
key. Repeating the same key returns the same run; changing its definition is a
conflict. `approve`, `cancel`, `retry`, and `replay` are owner-scoped. `poll`
recovers durable work; the Constellation installer calls it on startup and at
two-second intervals.

Primitive implementations receive an abort signal, stable idempotency key,
saved receipt, exact dependency outputs, `assertActive()`, and `checkpoint()`.
They must call `assertActive()` immediately before external work and honor the
abort signal where the downstream API supports it. `checkpoint()` stores the
receipt needed to reconcile an ambiguous result. Register a new version when
changing a primitive's meaning.

## Recovery and replay

A worker claims one renewable Mongo lease. Its writes require the exact live
lease; cancellation and a replacement worker fence late results. The graph,
resolved input fingerprints, results and receipts persist across process
restarts.

The replay policy is developer-owned:

- `safe`: repeated execution has no external effect.
- `idempotent`: interrupted execution resumes using its original key/receipt.
  A fresh replay still requires an explicit `canReplay` guard.
- `guarded`: a `canReplay` receipt check is required before retry or replay.
- `never`: interrupted execution needs inspection and cannot be repeated by
  the retry/replay controls.

**Restart from here** creates a new run. It copies completed ancestor results,
resets the chosen step and its descendants, and requires fresh checkpoint
approval. The original run remains in history. A replay that would silently
restart another unfinished branch is refused.

The built-in agent primitive creates a durable child Session, using a
deterministic ID and an atomic Session/first-Message transaction. A retry adopts
that same Session. A new model-only replay is allowed only when the original
Session contains no tool calls; even a read tool is conservatively treated as a
possible effect. Agent runs that requested tools require inspection before a
new run. This guard cannot promise exactly-once effects in an arbitrary remote
service; that remains the registered tool's idempotency contract.

## Ownership, versions and budgets

The Constellation adapter checks the workspace owner, active Mission, current
Mission Crew membership, enabled Agent status and the saved Crew revision.
Those checks run again before every resumed provider or tool operation.
Reconfiguring an Agent therefore requires saving the plan again before it can
use the changed revision.

Run budgets are bounded by the Mission settings. Agent steps receive fixed
shares of the run's turns, tool calls and spend, including their nested
delegations. An existing Crew limit can further reduce a share. The run also
has a total dispatch limit and active-time limit. Approval wait time does not
consume its active-time allowance. Provider charges can exceed a remaining
spend allowance by the cost of one in-flight request, as with ordinary Agent
Sessions; the limit is checked before the next request.

Publications expose labels, readable results and approval state. Private
receipts and raw JSON outputs stay out of the operator interface. The parent
Mission owns workflow history and all child Sessions; erasing it removes that
history with the conversation.

## Decision nodes and conditional steps

With **Follow these steps** selected, **+ Decision** adds a saved Jev decision
revision. Choose the agent whose decision access applies, fill its named text,
number and yes/no inputs, and optionally select one text input to receive
dependency results. The plan saves the decision definition, input fields and
agent revision; editing or revoking the node does not silently update a run.
Save the plan again to adopt a changed revision.

Steps can use **Run condition** to select a Choice option, compare a Score or
yes probability (Noul), or act as the explicit fallback when no sibling result
condition matches. Choice and Score conditions may require minimum confidence;
Noul is itself a probability and has no separate confidence field. Conditions
are typed data, not expressions or code. Missing or invalid results fail closed,
rather than entering a fallback. The model's judgment never grants tool access.

Unselected branches become **Skipped**, with a visible reason, and consume no
execution budget. Ordinary dependent steps also skip if a required branch was
skipped. To combine alternative branches, choose **Branches of [decision]** as
the dependency group and **Continue if any dependency ran**. This waits until
all branches have completed or skipped, then runs only if at least one completed.

A branch rechecks the source decision's availability both when approval is
answered and when work resumes, including child provider and tool boundaries.
Revoked or edited decisions remain readable in history but cannot authorize a
future conditional step. Replays preserve unaffected completed/skipped states,
re-evaluate affected decisions and branches, and require fresh approvals.

Decision calls use a durable request key. A retry may adopt a completed receipt;
an uncertain request is not blindly repeated. Starting a new run is an explicit
new evaluation. TypeSafe call/token caps apply separately from agent-model spend;
the plan's total step/time budgets still include decision work. The isolated
Agent Evaluation Lab remains unchanged: it can observe requested decision tools
but never executes them. Decision fixtures are tested through Decisions.

## Verification

`app/packages/agent/tests/workflows.test.ts` exercises graph and schema
validation, owner scope, duplicate start keys, dependency ordering, parallel
joins, exact approval fingerprints, permission revocation, uncertain side
effects, cancellation races, checkpoint replay, actual Agent child Sessions,
and parked tool approval recovery. It runs through the normal package test
entry point.

`app/tests/constellation-decision-workflows.js` covers Choice/Score/Noul branches,
fallbacks and confidence, durable skips and joins, invalid outputs, replay,
decision revocation while waiting for approval, pinned typed-input adapters,
safe failure messages, and actual plan editor controls without paid calls.
