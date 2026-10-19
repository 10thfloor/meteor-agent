import { createHash } from 'crypto';
import { Random } from 'meteor/random';
import { AgentSessions } from '../common/collections';
import type { AgentSession } from '../common/types';
import { modelFrom, modelParticipants } from '../common/participants';
import type { ResolvedTool, ToolSpec, ToolResult } from './tools';
import { getAgent } from './registry';
import { commitLeasedMessage } from './transcript';

export const HANDOFF_TOOL_NAME = 'handoff_to_agent';
export const HANDOFF_MESSAGE_MAX = 8000;
export const HANDOFF_ARGS = {
  type: 'object',
  properties: {
    agent: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact agent handle from the conversation roster, without @.' },
    message: { type: 'string', minLength: 1, maxLength: HANDOFF_MESSAGE_MAX, description: 'The request or context for the colleague to answer in this conversation.' },
  },
  required: ['agent', 'message'], additionalProperties: false,
} as const;

// Identity, not a caller-controlled name/result, authorizes this control action.
// It must only execute at the dispatch seam that atomically commits its wake.
const HANDOFF_TOOL: ResolvedTool = Object.freeze({
  name: HANDOFF_TOOL_NAME,
  description: 'Hand this shared conversation to one rostered agent and end your turn. Call this tool alone. The colleague replies here with shared conversation context; this is not a delegated child task. Do not use a prose @mention to request a handoff.',
  args: HANDOFF_ARGS, kind: 'inline', gate: 'auto',
  run: async () => { throw new Error('Conversation handoff requires the Turn dispatcher.'); },
});

export function isHandoffTool(tool: ResolvedTool | undefined): boolean { return tool === HANDOFF_TOOL; }

export function assertHandoffNameFree(specs: ToolSpec[]): void {
  if (specs.some((spec) => {
    if (typeof spec === 'string') return spec === HANDOFF_TOOL_NAME;
    if ('mcp' in spec) return false;
    return (('name' in spec ? spec.name : undefined)
      ?? ('method' in spec ? spec.method : undefined)
      ?? ('subagent' in spec ? spec.subagent : undefined)) === HANDOFF_TOOL_NAME;
  })) throw new Error(`[10thfloor:agent] "${HANDOFF_TOOL_NAME}" is reserved for shared-conversation handoffs. Rename the app-authored tool.`);
}

export function withHandoffTool(tools: ResolvedTool[], conversation?: {
  session: Pick<AgentSession, 'agent' | 'participants' | 'parent' | 'ephemeral'>; agent: string;
}): ResolvedTool[] {
  const session = conversation?.session;
  if (!session || session.parent || session.ephemeral) return tools;
  const models = modelParticipants(session);
  return models.some((p) => p.agent === conversation!.agent)
    && models.some((p) => p.agent !== conversation!.agent) ? [...tools, HANDOFF_TOOL] : tools;
}

type HandoffOutcome = { kind: 'committed' } | { kind: 'abandoned' } | { kind: 'refused'; result: ToolResult; capped?: boolean };
const refuse = (error: string, reason: string, capped = false): HandoffOutcome => ({
  kind: 'refused', result: { ok: false, error: { error, reason } }, ...(capped ? { capped: true } : {}),
});

/** No external side effect. The receipt, budget and durable activation marker
 * are one leased transaction. A human send/roster edit/Stop winning the race
 * cannot leave a message claiming a handoff that was never scheduled. */
export async function commitHandoff(input: {
  sessionId: string; sourceAgent: string; userId: string | null;
  messageId: string; toolCallId: string; args: unknown;
  relayCap: number; toolCallCap?: number; authorize(): Promise<boolean>;
}): Promise<HandoffOutcome> {
  const args = input.args as { agent?: unknown; message?: unknown } | null;
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => key !== 'agent' && key !== 'message')
    || typeof args.agent !== 'string' || !args.agent.trim() || args.agent.length > 128
    || typeof args.message !== 'string' || !args.message.trim() || args.message.length > HANDOFF_MESSAGE_MAX
    || Buffer.byteLength(args.message, 'utf8') > HANDOFF_MESSAGE_MAX * 4) {
    return refuse('invalid-args', 'Choose a rostered agent handle and a nonempty message of at most 8000 characters.');
  }
  if (args.agent === input.sourceAgent) return refuse('handoff-self', 'Choose another agent in this conversation.');
  if (!(await input.authorize())) return refuse('not-allowed', 'This agent may not hand off this conversation.');
  const session = await AgentSessions.findOneAsync(input.sessionId);
  if (!session || session.phase === 'stopped' || session.userId !== input.userId) return { kind: 'abandoned' };
  if (session.parent || session.ephemeral) return refuse('handoff-unavailable', 'Handoffs are only available in shared conversations, not delegated or temporary sessions.');
  const models = modelParticipants(session);
  const source = models.find((p) => p.agent === input.sourceAgent);
  const target = models.find((p) => p.agent === args.agent);
  if (!source || !target || !getAgent(target.agent!)) return refuse('handoff-unavailable', 'That agent is no longer available in this conversation.');
  if ((session.relay ?? 0) >= input.relayCap) return refuse('budget-exhausted', 'Relay budget reached — a human message resets it.', true);
  if (input.toolCallCap !== undefined && (session.budgetSpent?.toolCalls ?? 0) >= input.toolCallCap) {
    return refuse('budget-exhausted', 'Tool-call budget reached.');
  }
  const message = args.message.trim();
  const seq = await commitLeasedMessage(input.sessionId, {
    _id: `handoff${createHash('sha256').update(`${input.messageId}:${input.toolCallId}`).digest('hex').slice(0, 32)}`,
    role: 'tool', kind: 'handoff', toolCallId: input.toolCallId,
    from: modelFrom(input.sourceAgent), to: target.id,
    content: JSON.stringify({ handedOff: true, agent: target.agent, message }),
    displayContent: `Sent to ${target.displayName}`, transcriptContent: message,
    createdAt: new Date(),
  }, {
    unlessStopped: true,
    expected: {
      userId: input.userId, nextSeq: session.nextSeq,
      relay: session.relay === undefined ? { $exists: false } : session.relay,
      $and: [
        { participants: { $elemMatch: { id: source.id, kind: 'model', agent: source.agent } } },
        { participants: { $elemMatch: { id: target.id, kind: 'model', agent: target.agent } } },
      ],
    },
    inc: { 'budgetSpent.toolCalls': 1 },
    set: { pendingRelay: { agent: target.agent!, token: Random.id() }, relay: (session.relay ?? 0) + 1 },
  });
  return { kind: seq === null ? 'abandoned' : 'committed' };
}
