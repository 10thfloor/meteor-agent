import { assert } from 'chai';
import { Random } from 'meteor/random';
import { destroyMongoStorage, loadChord, loadPiAi, loadPiDurable, openMongoStorage } from 'meteor/10thfloor:durable';

// The whole Pi Durable harness, not only its storage contract, running in a
// Meteor server process on MongoStorage: a model turn with a tool call, an
// application document changed in the same commits, and a reopen. The model
// is pi-ai's faux provider, so nothing leaves the process.

describe('Pi Durable harness on MongoStorage, inside Meteor', function () {
  this.timeout(120_000);

  let durable: any;
  let context: any;
  let Type: any;
  let createModels: any;
  let faux: any;
  const keys: string[] = [];

  const newKey = (): string => {
    const key = `harness-${Random.id()}`;
    keys.push(key);
    return key;
  };

  /** A models registry holding one faux provider that will give these responses in order. */
  const scripted = (responses: unknown[]) => {
    const provider = faux.fauxProvider();
    const models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses(responses);
    return models;
  };

  const text = (message: any): string => {
    if (!message || message.role === 'system') return '';
    if (typeof message.content === 'string') return message.content;
    return message.content.flatMap((part: any) => (part.type === 'text' ? [part.text] : [])).join('');
  };

  /** The transcript, oldest first, as `kind` or `kind:text`. */
  const transcript = async (conversation: any): Promise<string[]> => {
    const page = await conversation.entries({}, 100, undefined, context);
    return [...page.items].reverse().map((entry: any) => {
      const said = text(entry.model?.[0]);
      return entry.kind === 'pi.system' || said === '' ? entry.kind : `${entry.kind}:${said}`;
    });
  };

  before(async function () {
    durable = await loadPiDurable();
    context = (await loadChord('context') as any).BACKGROUND_CONTEXT;
    Type = (await loadPiAi() as any).Type;
    createModels = (await loadPiAi('models') as any).createModels;
    faux = await loadPiAi('providers/faux');
  });

  after(async function () {
    for (const key of keys) await destroyMongoStorage(key);
  });

  it('answers an input through a tool that edits an application document, and keeps all of it across reopen', async function () {
    const key = newKey();
    const Todos = durable.defineDoc({
      kind: 'app.todos',
      version: 1,
      scope: 'conversation',
      history: 'rewindable',
      fork: 'asOf',
      initial: () => ({ items: [] }),
    });
    const registry = durable.createRegistry();
    registry.install(durable.defineExtension({
      name: 'todo',
      tools: [durable.defineTool({
        name: 'todo',
        description: 'Add an item to the todo list',
        parameters: Type.Object({ item: Type.String() }),
        execute: async (args: any, api: any, callContext: any) => {
          await api.commit(async (tx: any) => {
            (await tx.doc(Todos, api.conversationId)).items.push(args.item);
          }, callContext);
          return { content: [{ type: 'text', text: `Added ${args.item}` }] };
        },
      })],
    }));
    const models = scripted([
      faux.fauxAssistantMessage([faux.fauxToolCall('todo', { item: 'write the report' })], { stopReason: 'toolUse' }),
      faux.fauxAssistantMessage('Added it.'),
    ]);

    const harness = await durable.Harness.open(await openMongoStorage(key), { models, registry }, context);
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
    const submission = await root.submit({ type: 'input', content: 'Remember the report.', requestId: 'r-1' }, context);
    const settled = await submission.wait(context);
    assert.strictEqual(settled.status, 'done');
    const expected = [
      'pi.user:Remember the report.',
      'pi.system',
      'pi.assistant',
      'pi.tool-result:Added write the report',
      'pi.assistant:Added it.',
    ];
    assert.deepEqual(await transcript(root), expected);
    assert.deepEqual(await harness.snapshot(Todos, root.id, context), { items: ['write the report'] });
    await harness.close(context);

    // A new harness over the same key, as after a server restart.
    const reopened = await durable.Harness.open(
      await openMongoStorage(key),
      { models: createModels(), registry: durable.createRegistry() },
      context,
    );
    const again = await reopened.root(context);
    assert.deepEqual(await transcript(again), expected);
    assert.deepEqual(await reopened.snapshot(Todos, again.id, context), { items: ['write the report'] });
    // The same request ID finds the submission that was already answered; nothing is asked twice.
    const repeated = await again.submit({ type: 'input', content: 'Remember the report.', requestId: 'r-1' }, context);
    assert.strictEqual(repeated.id, submission.id);
    assert.strictEqual((await repeated.status(context)).status, 'done');
    assert.deepEqual(await transcript(again), expected);
    await reopened.close(context);
  });

  // A server instance that stops answering in the middle of a tool call, and a second one that takes the storage.
  // Here both are harnesses in one process; the first never returns from its tool, exactly as a hung or
  // partitioned instance would not. (The same two cases with a real `kill -9` between two processes were run
  // under plain Node while this package was written.)
  for (const replay of ['safe', 'unsafe'] as const) {
    const title = replay === 'safe'
      ? 'reruns a replay-safe tool in a second harness when the first never finished the call'
      : 'tells the model an unsafe tool was interrupted, with its output so far, instead of running it again';
    it(title, async function () {
      const key = newKey();
      const job = { type: 'input', content: 'Run the long job.', requestId: 'job-1' };
      const slow = (execute: (args: any, api: any, callContext: any) => Promise<any>) => {
        const registry = durable.createRegistry();
        registry.install(durable.defineExtension({
          name: 'work',
          tools: [durable.defineTool({
            name: 'slow',
            description: 'A long job',
            parameters: Type.Object({ job: Type.String() }),
            replay,
            execute,
          })],
        }));
        return registry;
      };

      let reached!: () => void;
      const inTool = new Promise<void>((resolve) => { reached = resolve; });
      const first = await durable.Harness.open(
        await openMongoStorage(key),
        {
          models: scripted([
            faux.fauxAssistantMessage([faux.fauxToolCall('slow', { job: 'index the repo' })], { stopReason: 'toolUse' }),
            faux.fauxAssistantMessage('Finished by the first harness.'),
          ]),
          registry: slow(async (_args, api, callContext) => {
            api.output('started in the first harness\n');
            // Running output is committed at most every 100 ms; let that window pass before the takeover.
            setTimeout(reached, 400);
            // Never returns on its own: only this harness closing ends the call.
            await new Promise((_, reject) => {
              const signal = callContext.abortSignal;
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            return {};
          }),
          onReport: () => undefined,
        },
        context,
      );
      const firstRoot = await first.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      const admitted = await firstRoot.submit(job, context);
      await inTool;

      let runs = 0;
      const second = await durable.Harness.open(
        await openMongoStorage(key),
        {
          models: scripted([faux.fauxAssistantMessage('Finished by the second harness.')]),
          registry: slow(async () => {
            runs += 1;
            return { content: [{ type: 'text', text: 'result from the second harness' }] };
          }),
        },
        context,
      );
      second.resume();
      const secondRoot = await second.root(context);
      // The same request ID finds the submission the first harness admitted; nothing is asked twice.
      const found = await secondRoot.submit(job, context);
      assert.strictEqual(found.id, admitted.id);
      assert.strictEqual((await found.wait(context)).status, 'done');

      const lines = await transcript(secondRoot);
      assert.strictEqual(lines[lines.length - 1], 'pi.assistant:Finished by the second harness.');
      const results = lines.filter((line) => line.startsWith('pi.tool-result'));
      assert.lengthOf(results, 1);
      if (replay === 'safe') {
        assert.strictEqual(runs, 1);
        assert.strictEqual(results[0], 'pi.tool-result:result from the second harness');
      } else {
        assert.strictEqual(runs, 0);
        assert.include(results[0], 'interrupted');
        assert.include(results[0], 'started in the first harness');
      }

      // The first harness is still there. Closing it ends its tool call, and whatever it then tries to record is
      // refused: the transcript the second harness finished does not change.
      await Promise.race([
        first.close(context).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      assert.deepEqual(await transcript(secondRoot), lines);
      await second.close(context);
    });
  }

  it('refuses the writes of a harness whose storage a later open has taken', async function () {
    const key = newKey();
    const agent = { model: { provider: 'faux', modelId: 'faux-1' } };
    const first = await durable.Harness.open(
      await openMongoStorage(key),
      { models: scripted([faux.fauxAssistantMessage('One.')]), registry: durable.createRegistry() },
      context,
    );
    const firstRoot = await first.root(context, { agent });
    assert.strictEqual((await (await firstRoot.submit({ type: 'input', content: 'First?' }, context)).wait(context)).status, 'done');

    // A second server instance opens the same storage while the first still holds its harness.
    const second = await durable.Harness.open(
      await openMongoStorage(key),
      { models: scripted([faux.fauxAssistantMessage('Two.')]), registry: durable.createRegistry() },
      context,
    );
    const secondRoot = await second.root(context);

    const refused = await firstRoot.submit({ type: 'input', content: 'Still mine?' }, context).then(
      () => undefined,
      (error: Error) => error,
    );
    assert.strictEqual(refused?.name, 'StorageOwnershipLost');

    assert.strictEqual((await (await secondRoot.submit({ type: 'input', content: 'Second?' }, context)).wait(context)).status, 'done');
    assert.deepEqual(await transcript(secondRoot), [
      'pi.user:First?',
      'pi.assistant:One.',
      'pi.user:Second?',
      'pi.assistant:Two.',
    ]);
    await second.close(context);
  });
});
