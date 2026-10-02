// What can be asked of a conversation from any server instance.
//
// These are the operations a host registers by default. Each takes JSON and
// returns JSON, because a request may cross from the instance that was asked
// to the instance that hosts the storage. They are thin: every one is a call
// on Pi Durable's own Harness or Conversation.
import type { AgentChange, Conversation } from "@earendil-works/pi-durable";
import type { Operation, OperationScope } from "./host";

/** A conversation's agent choices as they are stored: extensions and tools by name. */
export type AgentChoices = {
	model?: { provider: string; modelId: string } | null;
	thinkingLevel?: string | null;
	/** An array selects exactly these extensions; an object edits the host's default selection. */
	extensions?: string[] | { add?: string[]; remove?: string[] } | null;
	/** An array offers exactly these tools; `{ remove }` drops some. */
	tools?: string[] | { remove: string[] } | null;
	instructions?: string | null;
	cwd?: string | null;
};

/** No conversation with that ID in the storage. */
export class ConversationNotFound extends Error {
	constructor(key: string, id: unknown) {
		super(`No conversation ${String(id)} in storage ${JSON.stringify(key)}`);
		this.name = "ConversationNotFound";
	}
}

// Pi Durable takes extension and tool objects and stores only their names, so a name is all it needs here.
const named = (names: readonly string[]) => names.map((name) => ({ name }));

function agentChange(choices: AgentChoices | undefined): AgentChange | undefined {
	if (choices === undefined) return undefined;
	const { extensions, tools, ...rest } = choices;
	return {
		...rest,
		...(extensions === undefined
			? {}
			: {
					extensions:
						extensions === null || Array.isArray(extensions)
							? extensions === null
								? null
								: named(extensions)
							: {
									...(extensions.add === undefined ? {} : { add: named(extensions.add) }),
									...(extensions.remove === undefined ? {} : { remove: named(extensions.remove) }),
								},
				}),
		...(tools === undefined
			? {}
			: { tools: tools === null ? null : Array.isArray(tools) ? named(tools) : { remove: named(tools.remove) } }),
	} as AgentChange;
}

async function conversation(scope: OperationScope, id: unknown): Promise<Conversation> {
	const found = typeof id === "number" ? await scope.harness.conversation(id as never, scope.context) : undefined;
	if (found === undefined) throw new ConversationNotFound(scope.key, id);
	return found;
}

const withAgent = (agent: AgentChoices | undefined) => (agent === undefined ? {} : { agent: agentChange(agent)! });

export const OPERATIONS: Readonly<Record<string, Operation>> = {
	/** The root conversation, created on first use with `agent`. */
	root: async (args: { agent?: AgentChoices } | undefined, scope) => {
		const root = await scope.harness.root(scope.context, withAgent(args?.agent));
		return { conversationId: root.id };
	},

	/** A new conversation nobody owns. */
	create: async (args: { agent?: AgentChoices } | undefined, scope) => {
		const created = await scope.harness.createConversation(
			{ ownership: { kind: "ownerless" }, ...withAgent(args?.agent) },
			scope.context,
		);
		return { conversationId: created.id };
	},

	/** A fork of `conversationId` at the entry `at`, which sees the parent's history up to there. */
	fork: async (args: { conversationId: number; at: number; agent?: AgentChoices }, scope) => {
		const parent = await conversation(scope, args.conversationId);
		const fork = await parent.fork(
			args.at as never,
			{ ownership: { kind: "ownerless" }, ...withAgent(args.agent) },
			scope.context,
		);
		return { conversationId: fork.id };
	},

	/**
	 * User input, or a passive entry write. The request's own ID is the submission's `requestId` unless the caller
	 * gave one, so a request that is delivered twice is admitted once.
	 */
	submit: async (args: { conversationId: number; draft: Record<string, unknown> }, scope) => {
		const target = await conversation(scope, args.conversationId);
		const draft = { ...args.draft, requestId: args.draft.requestId ?? scope.requestId };
		const submission = await target.submit(draft as never, scope.context);
		return { submissionId: submission.id };
	},

	/**
	 * Stop a conversation's current work. `idle` says whether it had stopped when this returned; a tool that ignores
	 * its signal can take longer than a request should wait.
	 */
	abort: async (args: { conversationId: number; background?: boolean; waitMs?: number }, scope) => {
		const target = await conversation(scope, args.conversationId);
		const stopped = target.abort(scope.context, args.background === true ? { background: true } : undefined).then(() => true);
		const idle = await Promise.race([
			stopped,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), args.waitMs ?? 5000)),
		]);
		// Left to finish alone; its outcome is the conversation's state, which anyone can read.
		stopped.catch(() => undefined);
		return { idle };
	},

	/** Withdraw a queued submission. */
	withdraw: async (args: { submissionId: number; conversationId?: number }, scope) => ({
		result: await scope.harness.abortSubmission(args.submissionId as never, scope.context, args.conversationId as never),
	}),

	/** Start a new context, optionally from a handoff note. Older entries stay in storage. */
	reset: async (args: { conversationId: number; handoff?: string }, scope) => {
		await (await conversation(scope, args.conversationId)).reset(args.handoff, scope.context);
		return {};
	},

	/** Summarize older entries now. Returns the compaction task's ID. */
	compact: async (args: { conversationId: number; instructions?: string }, scope) => ({
		taskId: await (await conversation(scope, args.conversationId)).compact(args.instructions, scope.context),
	}),

	/** Change what a conversation runs with. */
	configure: async (args: { conversationId: number; agent: AgentChoices }, scope) => {
		await (await conversation(scope, args.conversationId)).configure(agentChange(args.agent)!, scope.context);
		return {};
	},
};
