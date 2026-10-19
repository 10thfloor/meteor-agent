# Decision nodes in Constellation

Use a decision node when a task needs a repeatable judgment: choose a route,
check whether evidence supports a claim, or rate candidates against a concrete
scale. Use ordinary tools for calculations, exact lookups and actions.

## Setup and access

Open **Capabilities → Decisions → Jev connection**. Add a TypeSafe key there, or start the
desktop app with `TYPESAFE_API_KEY` in its environment. Saved keys use the same
OS-protected encryption key as Constellation's other connections. Keys are
never published to the browser after saving.

Enable the connection and choose which agents may use decisions. Node assignment
and agent access are both required. Separately choose whether each agent can
create nodes: disabled, review first, or automatic. Creating a node never gives
an agent new tool permissions or permission to take the selected action.

The three Jev tools always appear in **Capabilities → Tools**, including when
access is off. Search for **Jev** to see their requirements and open the relevant
connection or access settings. Finding and creating definitions do not call
TypeSafe; evaluating requires a key. **Agent settings → Decision access** shows
separate Use and Create permissions, also summarized on the agent's profile.

The desktop and its database remain local. Evaluating a node sends its questions
and the supplied input to TypeSafe's hosted API. Do not include credentials or
unrelated personal information in that input. Decision token and call limits are
separate from the language model's dollar budget; token totals are not a dollar
cost estimate.

The call limit counts HTTP attempts, including a rate-limit retry. Manual
workspace tests share a daily allowance; mission tests and agent/plan evaluations
share their mission's allowance. If a request's outcome is unknown, a conservative
token reservation remains counted against the limit and the history says usage
is unconfirmed. It is not presented as measured usage or a known charge.

### Mission costs

With a Jev key connected, **Mission health → Jev cost · est.** shows the current
mission's estimated TypeSafe spend, including specialist work. Click the tile for
the exact amount and reported input/output tokens. Charges below one cent appear
as **<$0.01**, not zero. Pausing evaluations keeps the cost visible; removing the
connection hides it. Workspace-only tests are not attributed to a mission.

The estimate uses the response's resolved model and measured usage, not budget
reservations. The verified [Jev 1.13 rate](https://docs.typesafe.ai/models) is
$0.042 per million input tokens with free output (checked September 21, 2026).
New responses save their rate snapshot; older responses for that known version
use the verified rate. Unknown models and unconfirmed requests are explicitly
excluded and marked as a partial estimate; check TypeSafe billing for those
charges. This is not an invoice and does not change the mission's model-spend
limit. The summary includes the full mission history, not only the most recent
100 decision runs shown in the catalog.

## Create, test and reuse

1. Add a decision, name its input fields, and write its questions.
2. For **Choose an option**, describe each option and include a no-match option
   when appropriate. For **Yes or no**, ask a specific condition. For **Rate on
   a scale**, describe every level in increasing order.
3. Put independent questions using the same input in one node. They are evaluated
   together; they cannot read each other's answers.
4. Add representative test cases and expected choices or numeric ranges. Run
   the tests before promoting a mission-local node for workspace reuse. Passing
   examples demonstrate those examples, not general correctness.
5. Review history to inspect the exact input, version, model, result and usage.
   Editing a decision creates a new revision; old results retain their snapshot.

Agents use stable `find_decision_nodes`, `create_decision_node` and
`evaluate_decision_node` tools. They can discover, create and evaluate within one
session without rebuilding the tool catalog. Agent-created nodes are mission-local;
review-first creations must be approved before evaluation. Workspace promotion is
a separate human action.

To try agent-created decisions, give an agent use access and choose **Ask for
approval** or **Allow automatically** for creation. In a mission containing that agent, ask:
“Create a reusable decision to classify these support requests as billing,
technical, or unclear, then evaluate this request: I was charged twice.”
Review-first creation appears in the mission as a decision card. Approval requests
one continuation in the creating agent's original conversation. It queues behind
current work when possible; it does not reactivate a stopped or inactive mission.
The card reports progress or explains why manual continuation is needed. For a
specialist, **View work** opens that specialist's conversation—not a new Atlas
turn. Repeating an approval adopts its receipt rather than starting another turn.
Stopping the conversation or pausing the mission cancels its pending decision
continuation. Sending a new message does not revive that cancelled request.
Automatic creation can proceed in the same turn. Both paths keep the definition
and evaluation history available to inspect.

An agent-created decision initially belongs only to its creator. Open the
decision and choose **Share with crew** to select other eligible agents in that
mission. Sharing does not change their workspace permissions: agents marked
**Use off** still need explicit access. Assignment changes are revision-checked
and audited separately from editing the questions. Workspace reuse remains a
separate human action after tests pass.

## Plans and runs

Add a decision step to a plan and choose its node and agent. Set subsequent steps
to run for a matching answer or as an explicit fallback. A choice/score confidence
threshold measures the shape of the model's probability distribution, not whether
an action is authorized. A yes/no result is the probability of yes; it has no
separate confidence field.

Nonmatching branches are marked **Skipped**. A branch join can wait for all
branches to settle and continue after any matching branch completes. Saved plans
pin the node revision; if a node or its access changes, execution rechecks that
policy instead of silently using a different definition. Existing approval
checkpoints still govern consequential work.

Decision tests are a separate, explicitly paid evaluation path. Agent Lab's
existing isolation remains intact: a simulated agent tool call is not a real
TypeSafe evaluation.

## Implementation boundaries

- Meteor owns nodes, immutable revision snapshots, access policy and receipts.
- TypeSafe evaluates typed questions; node definitions are data, never generated
  executable code.
- User and mission ownership, active agent membership, assignment, node revision
  and enabled state are checked at dispatch, not merely when a tool is listed.
- API errors are sanitized. Missing credentials do not trigger fake success.
- Retries and recovery must not silently repeat uncertain paid requests.
- Each explicit manual test has a stable request ID. Reconnecting reuses that
  request; deliberately starting another test creates a new paid request.

Provider contracts: [HTTP API](https://docs.typesafe.ai/api),
[question primitives](https://docs.typesafe.ai/primitives), and
[function calling](https://docs.typesafe.ai/cookbooks/function_calling).
