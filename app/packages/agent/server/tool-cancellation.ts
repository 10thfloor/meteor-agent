import { AgentSessions } from '../common/collections';
import { SERVER_ID } from './lease';

/** @internal Cooperative cancellation for one running inline tool. The
 * provider must actually honor the signal; arbitrary JavaScript cannot be
 * safely killed by this monitor. No database observers are left behind. */
export interface ToolCancellation {
  signal: AbortSignal;
  close(): Promise<void>;
}

/** @internal Polling is deliberate: standalone Mongo observers can coalesce
 * Stop transitions for seconds. Match the model exchange's 250ms bound while
 * also checking immutable ancestors, so a root fence cancels child work before
 * erasure has finished traversing and fencing its descendants. */
export async function beginToolCancellation(
  sessionId: string, interruptCheckMs = 250,
): Promise<ToolCancellation> {
  const controller = new AbortController();
  let closed = false;
  let checking: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const ids: string[] = [];
  const stoppedAt = new Map<string, number | undefined>();
  const interrupt = (): void => {
    if (!controller.signal.aborted) {
      const error = new Error('The tool execution is no longer active.');
      error.name = 'AbortError';
      controller.abort(error);
    }
    if (timer) clearInterval(timer);
  };
  try {
    let current: string | undefined = sessionId;
    while (current) {
      if (ids.includes(current)) { interrupt(); break; }
      ids.push(current);
      const row = await AgentSessions.findOneAsync(current, { fields: { parent: 1, stoppedAt: 1, phase: 1 } });
      if (!row) { interrupt(); break; }
      if (row.phase === 'stopped') { interrupt(); break; }
      stoppedAt.set(current, row.stoppedAt?.getTime());
      current = row.parent?.sessionId;
    }
  } catch { interrupt(); }

  const check = (): Promise<void> => {
    if (closed || controller.signal.aborted) return Promise.resolve();
    if (checking) return checking;
    checking = (async () => {
      try {
        const rows = await AgentSessions.find({ _id: { $in: ids } }, {
          fields: { phase: 1, stoppedAt: 1, erasingAt: 1, purgingAt: 1, lease: 1 },
        }).fetchAsync();
        if (closed) return;
        const target = rows.find((row) => row._id === sessionId);
        if (rows.length !== ids.length || rows.some((row) => row.phase === 'stopped' || row.erasingAt !== undefined || row.purgingAt !== undefined
          || row.stoppedAt?.getTime() !== stoppedAt.get(row._id))
          || target?.lease?.serverId !== SERVER_ID
          || !(target.lease.until instanceof Date) || target.lease.until.getTime() <= Date.now()) interrupt();
      } catch { if (!closed) interrupt(); }
    })().finally(() => { checking = null; });
    return checking;
  };
  await check();
  if (!controller.signal.aborted) {
    timer = setInterval(() => { void check(); }, Math.max(1, interruptCheckMs));
    (timer as any).unref?.();
  }
  return {
    signal: controller.signal,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await checking;
    },
  };
}
