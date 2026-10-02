import { loadChord, loadPiDurable } from 'meteor/10thfloor:durable';
import { loadPackage } from '../server/loader';

// What the server suites share: Pi Durable's pieces, loaded through the seam,
// and a model that needs no network and no script. It answers from the
// transcript alone, so any harness, on any instance, can continue what
// another began.

const PI_AI = '@earendil-works/pi-ai';

export const AGENT = { model: { provider: 'faux', modelId: 'faux-1' } } as const;

export const textOf = (message: any): string => {
  if (!message || message.role === 'system') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).flatMap((part: any) => (part?.type === 'text' ? [part.text] : [])).join('');
};

export type Pieces = {
  durable: any;
  context: any;
  /** Chord's `apply`: what a storage replays deltas with. */
  apply: any;
  Type: any;
  createModels: () => any;
  faux: any;
};

let pieces: Promise<Pieces> | undefined;
export function loadPieces(): Promise<Pieces> {
  pieces ??= (async () => ({
    durable: await loadPiDurable(),
    context: (await loadChord('context') as any).BACKGROUND_CONTEXT,
    apply: (await loadChord('delta') as any).apply,
    Type: (await loadPackage(PI_AI) as any).Type,
    createModels: (await loadPackage(PI_AI, 'models') as any).createModels,
    faux: await loadPackage(PI_AI, 'providers/faux'),
  }))();
  return pieces;
}

export type Slow = (job: string, signal: AbortSignal | undefined) => Promise<string>;

/**
 * Harness options over the transcript-driven model: it calls the tool `slow`
 * when the user says "work ...", reports the tool's result once it has one,
 * writes a long answer for "essay", and echoes anything else.
 * `tokensPerSecond` paces the answer so a viewer can watch it arrive.
 */
export function harnessOptions(
  { durable, Type, createModels, faux }: Pieces,
  options: { slow?: Slow; tokensPerSecond?: number } = {},
): Record<string, any> {
  const provider = faux.fauxProvider(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond });
  const models = createModels();
  models.setProvider(provider.provider);
  const step = (transcript: { messages: any[] }) => {
    const last = transcript.messages[transcript.messages.length - 1];
    if (last?.role === 'toolResult') return faux.fauxAssistantMessage(`tool said: ${textOf(last)}`);
    const said = textOf([...transcript.messages].reverse().find((message) => message.role === 'user'));
    if (said.startsWith('work')) {
      return faux.fauxAssistantMessage([faux.fauxToolCall('slow', { job: said })], { stopReason: 'toolUse' });
    }
    if (said.startsWith('essay')) {
      return faux.fauxAssistantMessage(Array.from({ length: 80 }, (_, index) => `word${index}`).join(' '));
    }
    return faux.fauxAssistantMessage(`echo: ${said}`);
  };
  provider.setResponses(Array.from({ length: 500 }, () => step));

  const slow = options.slow ?? (async (job: string) => `done ${job}`);
  const registry = durable.createRegistry();
  registry.install(durable.defineExtension({
    name: 'work',
    tools: [durable.defineTool({
      name: 'slow',
      description: 'A long job',
      parameters: Type.Object({ job: Type.String() }),
      replay: 'safe',
      execute: async (args: any, _api: any, callContext: any) => ({
        content: [{ type: 'text', text: await slow(args.job, callContext.abortSignal) }],
      }),
    })],
  }));
  return { models, registry };
}

/** Never resolves; rejects when the call is cancelled, as a well-behaved tool does. */
export const hang = (signal: AbortSignal | undefined) => new Promise<never>((_, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
