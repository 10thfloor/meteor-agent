import { Random } from 'meteor/random';
import { AgentDeltas, AgentMessages, AgentSessions } from '../common/collections';
import type { AgentMessage } from '../common/types';
import type { Provider, ProviderMessage } from './providers/types';
import { claimLease, guardedUpdate, releaseLease, SERVER_ID } from './lease';
import { resolveTools, runTool, toolSchemas, type ToolSpec } from './tools';

export interface RunConfig {
  model: string;
  system: string;
  tools: ToolSpec[];
  provider: Provider;
  maxIterations?: number;
  flushMs?: number;
}

/** Buffers deltas and flushes on an interval so a long response is O(chunk)
 *  on the wire rather than O(n²). */
class DeltaWriter {
  private buf: Array<{ kind: string; chunk: string }> = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionId: string,
    private messageId: string,
    private msgSeq: number,
    flushMs: number,
  ) {
    this.timer = setInterval(() => { void this.flush(); }, flushMs);
  }

  push(kind: string, chunk: string) { this.buf.push({ kind, chunk }); }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    for (const item of batch) {
      await AgentDeltas.insertAsync({
        _id: Random.id(),
        sessionId: this.sessionId,
        messageId: this.messageId,
        msgSeq: this.msgSeq,
        seq: this.seq++,
        kind: item.kind as any,
        chunk: item.chunk,
        at: new Date(),
      } as any);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }
}

function toProviderMessages(msgs: AgentMessage[]): ProviderMessage[] {
  return msgs
    .filter((m) => m.role !== 'note')
    .map((m) => ({
      role: m.role as ProviderMessage['role'],
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
    }));
}

/**
 * Run one turn to completion. Assistant messages commit only at boundaries, so
 * an abandoned turn always leaves the transcript ending in `user` or `tool` —
 * the two states a turn can legally start from. Recovery is therefore just
 * calling this again.
 */
export async function runTurn(sessionId: string, config: RunConfig): Promise<void> {
  const maxIterations = config.maxIterations ?? 10;
  const flushMs = config.flushMs ?? 60;
  const tools = resolveTools(config.tools);
  const schemas = toolSchemas(tools);

  if (!(await claimLease(sessionId))) return;   // another server owns this run

  try {
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const session = await AgentSessions.findOneAsync(sessionId);
      if (!session) return;

      const history = await AgentMessages
        .find({ sessionId }, { sort: { seq: 1 } }).fetchAsync();

      const messageId = Random.id();
      const msgSeq = session.nextSeq;
      if (!(await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'streaming' } }))) return;

      const writer = new DeltaWriter(sessionId, messageId, msgSeq, flushMs);
      let text = '';
      let thinking = '';
      let toolCalls: Array<{ id: string; name: string; args: unknown }> | undefined;
      let usage = { input: 0, output: 0 };

      try {
        for await (const chunk of config.provider.stream({
          model: config.model, system: config.system,
          messages: toProviderMessages(history), tools: schemas,
        })) {
          if (chunk.kind === 'text') { text += chunk.chunk; writer.push('text', chunk.chunk); }
          else if (chunk.kind === 'thinking') {
            thinking += chunk.chunk; writer.push('thinking', chunk.chunk);
          } else if (chunk.kind === 'done') {
            toolCalls = chunk.toolCalls;
            usage = chunk.usage ?? usage;
          }
        }
      } finally {
        await writer.stop();
      }

      // Commit is conditional on still owning the lease. Losing it means
      // another server is redoing this turn; abandon without writing.
      const stillOurs = await guardedUpdate(sessionId, SERVER_ID, {
        $inc: {
          nextSeq: 1,
          'usage.input': usage.input,
          'usage.output': usage.output,
        },
        $set: { updatedAt: new Date() },
      });
      if (!stillOurs) return;

      await AgentMessages.insertAsync({
        _id: messageId, sessionId, seq: msgSeq, role: 'assistant',
        content: text, thinking: thinking || undefined,
        toolCalls, usage, createdAt: new Date(),
      } as any);

      if (!toolCalls || toolCalls.length === 0) return;

      await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'calling' } });

      for (const call of toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        const result = tool
          ? await runTool(tool, call.args, { userId: session.userId, sessionId })
          : { ok: false, error: { error: 'unknown-tool', reason: `No tool named ${call.name}` } };

        const after = await AgentSessions.findOneAsync(sessionId);
        if (!after) return;
        if (!(await guardedUpdate(sessionId, SERVER_ID, {
          $inc: { nextSeq: 1, 'budgetSpent.toolCalls': 1 },
        }))) return;

        await AgentMessages.insertAsync({
          _id: Random.id(), sessionId, seq: after.nextSeq, role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result.ok ? result.value : result.error),
          error: result.ok ? undefined : result.error,
          createdAt: new Date(),
        } as any);
      }
    }
  } finally {
    await guardedUpdate(sessionId, SERVER_ID, { $set: { phase: 'idle' } });
    await releaseLease(sessionId);
  }
}
