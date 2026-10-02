import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { Mongo } from 'meteor/mongo';
import { Random } from 'meteor/random';
import { Durable, loadPiAi, loadPiDurable } from 'meteor/10thfloor:durable';
import { modelIdsFromCatalog } from '../imports/constellation/models';
import {
  DURABLE_DEFINITION,
  DURABLE_PLAN_KIND,
  PLAN_STATUSES,
  splitModelId,
  threadSpend,
  titleFromInput,
} from '../imports/constellation/durable';
import { refreshRadiusModels } from './model-providers';
import { detectOllamaModels, OLLAMA_OPENAI_URL } from './ollama';
// A cycle with the app's entry module, which imports this file. Nothing of it
// is used until a method or the harness runs.
import { modelCatalogView, workspaceOwnerCanApprove } from './main';

// Threads: Constellation's surface on `10thfloor:durable`.
//
// A thread is one Pi Durable storage: a root conversation, the forks made
// from it, a plan the agent keeps, and what it has spent. Everything the
// agent does is committed before it is shown, so a thread survives a restart
// in the middle of an answer, and any server instance can show it.
//
// The app keeps one row per thread beside the storage, because Pi Durable
// knows nothing of users or titles: who owns the thread, what it is called,
// which model it runs, and the conversations it has. Input goes through the
// app's own methods, so every one of them is checked against that row and
// against the thread's spending limit; watching, stopping and compacting go
// through the package's methods, gated by the same row.

export const DurableThreads = new Mongo.Collection('constellation_durable_threads');

const offline = process.env.CONSTELLATION_OFFLINE === '1';
const testing = Meteor.isTest || Meteor.isAppTest || process.env.NODE_ENV === 'test'
  || !!process.env.TEST_BROWSER_DRIVER;

const TITLE_MAX = 120;
const INPUT_MAX = 20_000;
const THREAD_LIMIT = 200;
const CONVERSATION_LIMIT = 24;
const PLAN_ITEMS_MAX = 24;
const PLAN_TEXT_MAX = 200;
const WAIT_MAX_SECONDS = 30;
const SCRIPTED = Object.freeze({ provider: 'constellation', modelId: 'scripted' });

const INSTRUCTIONS = [
  'You are working in a Constellation thread.',
  'When the work has more than one step, keep a short plan with update_plan: send the whole plan each time,',
  'and mark an item in_progress before you start it and done when it is finished.',
  'Answer plainly and briefly.',
].join(' ');

/** Dollars one thread may spend before it takes no more input and its tool rounds end. */
export function spendLimit() {
  const configured = Number(process.env.CONSTELLATION_DURABLE_SPEND_LIMIT);
  return Number.isFinite(configured) && configured >= 0 ? configured : 2;
}

const textOf = (message) => {
  if (!message || message.role === 'system') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? []).flatMap((part) => (part?.type === 'text' ? [part.text] : [])).join('');
};

// ── The model catalog a harness runs on ──────────────────────────────────────

/**
 * The scripted model: no network, no key, the same answer for the same
 * transcript. It is what a thread runs on offline and in tests, and it uses
 * the thread's tools, so the whole surface can be tried without a provider.
 */
function scriptedProvider(faux) {
  const handle = faux.fauxProvider({
    provider: SCRIPTED.provider,
    models: [{ id: SCRIPTED.modelId, name: 'Scripted (local)' }],
    tokensPerSecond: testing ? 400 : 60,
  });
  const respond = (transcript) => {
    const last = transcript.messages[transcript.messages.length - 1];
    if (last?.role === 'toolResult') return faux.fauxAssistantMessage(`Done. ${textOf(last)}`.trim());
    const users = transcript.messages.filter((message) => message.role === 'user');
    const said = textOf(users[users.length - 1]).trim();
    const plan = /^plan\s*:\s*(.+)$/is.exec(said);
    if (plan) {
      const items = plan[1].split(/[,;\n]/).map((text) => text.trim()).filter(Boolean)
        .slice(0, PLAN_ITEMS_MAX).map((text) => ({ text: text.slice(0, PLAN_TEXT_MAX), status: 'pending' }));
      return faux.fauxAssistantMessage([faux.fauxToolCall('update_plan', { items })], { stopReason: 'toolUse' });
    }
    const wait = /^wait\s+(\d{1,2})\b/i.exec(said);
    if (wait) {
      return faux.fauxAssistantMessage([faux.fauxToolCall('wait', { seconds: Number(wait[1]) })], { stopReason: 'toolUse' });
    }
    if (/\bwhat time\b|\btime is it\b/i.test(said)) {
      return faux.fauxAssistantMessage([faux.fauxToolCall('current_time', {})], { stopReason: 'toolUse' });
    }
    return faux.fauxAssistantMessage(
      `This is Constellation's scripted model, so the answer is the same every time. You said: "${said}". `
      + 'Try "plan: first, second, third", "wait 10" or "what time is it?" to see a tool run. '
      + 'With a provider key set, the same thread talks to a real model.',
    );
  };
  // One step is used up by every request; each puts one back, so the queue never runs out.
  const step = (transcript) => {
    handle.appendResponses([step]);
    return respond(transcript);
  };
  handle.setResponses(Array.from({ length: 32 }, () => step));
  return handle.provider;
}

/** Where pi-ai looks for credentials: the environment, with the app's generic key standing in for Anthropic's. */
const authContext = {
  async env(name) {
    const value = process.env[name];
    if (typeof value === 'string' && value !== '') return value;
    // PROVIDER_API_KEY is this app's historical Anthropic key; it is never offered to another provider.
    if (name === 'ANTHROPIC_API_KEY') return process.env.PROVIDER_API_KEY?.trim() || undefined;
    return undefined;
  },
  async fileExists(path) {
    return existsSync(path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path);
  },
};

async function buildModels() {
  const scripted = scriptedProvider(await loadPiAi('providers/faux'));
  if (offline) {
    const models = (await loadPiAi('models')).createModels();
    models.setProvider(scripted);
    return models;
  }
  const models = (await loadPiAi('providers/all')).builtinModels({ authContext });
  await refreshRadiusModels({ models, enabled: !testing });
  const ollama = await detectOllamaModels({ enabled: !testing });
  if (ollama.length > 0) {
    const [{ createProvider }, { openAICompletionsApi }] = await Promise.all([
      loadPiAi(), loadPiAi('api/openai-completions.lazy'),
    ]);
    models.setProvider(createProvider({
      id: 'ollama',
      name: 'Ollama',
      baseUrl: OLLAMA_OPENAI_URL,
      // Ollama ignores authentication; the OpenAI client insists on a key.
      auth: { apiKey: { name: 'Local Ollama', resolve: async () => ({ auth: { apiKey: 'ollama' }, source: 'Local Ollama' }) } },
      models: ollama,
      api: openAICompletionsApi(),
    }));
  }
  models.setProvider(scripted);
  return models;
}

// ── What the agent of a thread can do ────────────────────────────────────────

async function buildRegistry(durable) {
  const { Type } = await loadPiAi();
  const Plan = durable.defineDoc({
    kind: DURABLE_PLAN_KIND,
    version: 1,
    scope: 'conversation',
    // A fork goes on from the plan as it was at the entry it forks from, not
    // as it is now; that needs the plan's earlier values kept.
    history: 'rewindable',
    fork: 'asOf',
    initial: () => ({ items: [] }),
  });

  const updatePlan = durable.defineTool({
    name: 'update_plan',
    description: 'Replace the plan of this conversation. Send every item each time, in order, each with its status.',
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        text: Type.String({ minLength: 1, maxLength: PLAN_TEXT_MAX }),
        status: Type.Union(PLAN_STATUSES.map((status) => Type.Literal(status))),
      }), { maxItems: PLAN_ITEMS_MAX }),
    }),
    // The whole plan is sent each time, so running the call twice changes nothing.
    replay: 'safe',
    execute: async (args, api, context) => {
      await api.commit(async (tx) => {
        (await tx.doc(Plan, api.conversationId)).items = args.items.map(({ text, status }) => ({ text, status }));
      }, context);
      const done = args.items.filter((item) => item.status === 'done').length;
      return { content: [{ type: 'text', text: `Plan saved: ${args.items.length} items, ${done} done.` }] };
    },
  });

  const wait = durable.defineTool({
    name: 'wait',
    description: `Wait for a number of seconds, at most ${WAIT_MAX_SECONDS}. Use it only when the user asks to wait.`,
    parameters: Type.Object({ seconds: Type.Number({ minimum: 0, maximum: WAIT_MAX_SECONDS }) }),
    replay: 'safe',
    execute: async (args, api, context) => {
      const seconds = Math.min(Math.max(Math.round(args.seconds), 0), WAIT_MAX_SECONDS);
      const signal = context.abortSignal;
      for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
        if (signal?.aborted) throw signal.reason ?? new Error('Cancelled');
        api.output(`${elapsed + 1}s\n`);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Cancelled')); }, { once: true });
        });
      }
      return { content: [{ type: 'text', text: `Waited ${seconds} seconds.` }] };
    },
  });

  const currentTime = durable.defineTool({
    name: 'current_time',
    description: 'The current date and time on the server, in ISO 8601.',
    parameters: Type.Object({}),
    replay: 'safe',
    execute: async () => ({ content: [{ type: 'text', text: new Date().toISOString() }] }),
  });

  /**
   * Pi Durable has no budgets and no hook that refuses a model request. What
   * it has is a tool result that ends the run. Once a conversation has spent
   * its thread's limit, every tool result of a round says so, and the run
   * stops there instead of asking the model again.
   */
  const guard = durable.hook(durable.ToolTask, {
    afterTool: async (_call, result, api, context) => {
      const usage = await api.snapshot(durable.UsageDoc, api.conversationId, context);
      if (threadSpend(usage) < spendLimit()) return undefined;
      return {
        ...result,
        // A diagnostic, not content: a result without content keeps the output its tool streamed.
        diagnostics: [
          ...(result.diagnostics ?? []),
          {
            severity: 'warn',
            code: 'spend-limit',
            message: `Stopped: this thread reached its spending limit of $${spendLimit().toFixed(2)}.`,
          },
        ],
        control: { ...result.control, terminate: true },
      };
    },
  });

  const registry = durable.createRegistry();
  registry.install(durable.defineExtension({
    name: 'constellation',
    tools: [updatePlan, wait, currentTime],
    hooks: [guard],
  }));
  return registry;
}

let pieces;
/** Built once a process: what every thread's harness runs with. */
function harnessPieces() {
  if (pieces === undefined) {
    const building = (async () => {
      const durable = await loadPiDurable();
      const [models, registry] = await Promise.all([buildModels(), buildRegistry(durable)]);
      return { models, registry };
    })();
    pieces = building;
    building.catch(() => { if (pieces === building) pieces = undefined; });
  }
  return pieces;
}

// ── The definition ───────────────────────────────────────────────────────────

/** What a browser may ask of the package directly. Creating, forking and speaking go through the methods below. */
const DIRECT_ACTIONS = new Set(['view', 'abort', 'withdraw', 'reset', 'compact']);

export const Threads = new Durable(DURABLE_DEFINITION, {
  harness: () => harnessPieces(),
  allow: async (userId, action, { key }) => {
    if (!userId || !DIRECT_ACTIONS.has(action)) return false;
    return !!await DurableThreads.findOneAsync({ _id: key, userId }, { fields: { _id: 1 } });
  },
  documents: ['pi.live', 'pi.inbox', 'pi.usage', DURABLE_PLAN_KIND],
  operations: {
    /** What the whole thread has spent: every conversation's usage, summed. */
    usage: (_args, { harness, context }) => harness.usage(context),
  },
});

// ── The app's own methods ────────────────────────────────────────────────────

const Title = Match.Where((value) => {
  check(value, String);
  return value.trim().length > 0 && value.length <= TITLE_MAX;
});
const Id = Match.Where((value) => {
  check(value, String);
  return /^[A-Za-z0-9]{8,40}$/.test(value);
});
const PositiveInteger = Match.Where((value) => {
  check(value, Match.Integer);
  return value > 0;
});

/**
 * Who may use Threads: the workspace's owner. A property, so that a test can
 * stand in an owner without claiming the one workspace a test run has.
 */
export const access = {
  isOwner: (userId) => workspaceOwnerCanApprove({ userId }),
};

async function requireOwner(userId) {
  if (!userId || !await access.isOwner(userId)) {
    throw new Meteor.Error('not-authorized', 'This workspace belongs to another local account.');
  }
  return userId;
}

async function ownedThread(userId, threadId) {
  await requireOwner(userId);
  const thread = await DurableThreads.findOneAsync({ _id: threadId, userId });
  if (!thread) throw new Meteor.Error('no-thread', 'Thread not found.');
  return thread;
}

/** The agent choices for a thread's model: `default` follows the workspace default. */
async function agentFor(userId, model) {
  const catalog = await modelCatalogView(userId);
  const id = model === 'default' ? catalog.defaultModel : model;
  if (!modelIdsFromCatalog(catalog).has(id)) {
    throw new Meteor.Error('model-unavailable', 'This model is not available with the configured provider credentials.');
  }
  return { model: splitModelId(id), instructions: INSTRUCTIONS };
}

/** Errors a person can act on keep their meaning; everything else is the server's business. */
async function answering(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Meteor.Error) throw error;
    if (error?.name === 'ConversationNotFound') throw new Meteor.Error('no-conversation', 'Conversation not found.');
    if (error?.name === 'ConversationBusy') throw new Meteor.Error('conversation-busy', 'The conversation is busy.');
    if (error?.name === 'RequestExpired') throw new Meteor.Error('unavailable', 'No server took the request in time; try again.');
    throw error;
  }
}

Meteor.methods({
  async 'constellation.durableThreadCreate'(title) {
    check(title, Match.Maybe(Title));
    const userId = await requireOwner(this.userId);
    if (await DurableThreads.find({ userId }).countAsync() >= THREAD_LIMIT) {
      throw new Meteor.Error('thread-limit', `A workspace keeps at most ${THREAD_LIMIT} threads. Delete one first.`);
    }
    const agent = await agentFor(userId, 'default');
    const _id = Random.id();
    this.unblock();
    // The conversation first, the row second: a thread is listed only once it can be spoken to. Until its row
    // exists nobody but this call can reach the storage, since `allow` goes by the row.
    const conversationId = await answering(() => Threads.root(_id, agent));
    const now = new Date();
    try {
      await DurableThreads.insertAsync({
        _id,
        userId,
        title: title?.trim() || 'New thread',
        titled: !!title?.trim(),
        model: 'default',
        conversations: [{ id: conversationId, createdAt: now }],
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      await Threads.destroy(_id).catch(() => undefined);
      throw error;
    }
    return { threadId: _id, conversationId };
  },

  async 'constellation.durableThreadRename'(threadId, title) {
    check(threadId, Id);
    check(title, Title);
    await ownedThread(this.userId, threadId);
    await DurableThreads.updateAsync({ _id: threadId }, { $set: { title: title.trim(), titled: true, updatedAt: new Date() } });
    return {};
  },

  /** Hand input to a conversation of the thread. The request ID makes a retry after a lost connection one input. */
  async 'constellation.durableThreadSay'(params) {
    check(params, {
      threadId: Id,
      conversationId: PositiveInteger,
      text: Match.Where((value) => {
        check(value, String);
        return value.trim().length > 0 && value.length <= INPUT_MAX;
      }),
      whenBusy: Match.Maybe(Match.OneOf('steer', 'followUp')),
      requestId: Match.Where((value) => {
        check(value, String);
        return /^[A-Za-z0-9_-]{8,64}$/.test(value);
      }),
    });
    const thread = await ownedThread(this.userId, params.threadId);
    if (!thread.conversations.some((conversation) => conversation.id === params.conversationId)) {
      throw new Meteor.Error('no-conversation', 'Conversation not found.');
    }
    this.unblock();
    return answering(async () => {
      const spent = threadSpend(await Threads.call(thread._id, 'usage'));
      if (spent >= spendLimit()) {
        throw new Meteor.Error(
          'spend-limit',
          `This thread has reached its spending limit of $${spendLimit().toFixed(2)}. Start a new thread to go on.`,
        );
      }
      const admitted = await Threads.submit(thread._id, params.conversationId, {
        type: 'input',
        content: params.text,
        requestId: params.requestId,
        ...(params.whenBusy ? { whenBusy: params.whenBusy } : {}),
      });
      await DurableThreads.updateAsync(
        { _id: thread._id },
        {
          $set: {
            updatedAt: new Date(),
            // A thread is named after the first thing said in it, unless a person named it.
            ...(thread.titled ? {} : { title: titleFromInput(params.text), titled: true }),
          },
        },
      );
      return admitted;
    });
  },

  /** Fork a conversation of the thread at one of its entries; the fork is recorded with the thread. */
  async 'constellation.durableThreadFork'(threadId, conversationId, at) {
    check(threadId, Id);
    check(conversationId, PositiveInteger);
    check(at, PositiveInteger);
    const thread = await ownedThread(this.userId, threadId);
    if (!thread.conversations.some((conversation) => conversation.id === conversationId)) {
      throw new Meteor.Error('no-conversation', 'Conversation not found.');
    }
    if (thread.conversations.length >= CONVERSATION_LIMIT) {
      throw new Meteor.Error('fork-limit', `A thread keeps at most ${CONVERSATION_LIMIT} conversations.`);
    }
    this.unblock();
    return answering(async () => {
      const forkId = await Threads.fork(thread._id, conversationId, at);
      const now = new Date();
      await DurableThreads.updateAsync(
        { _id: thread._id },
        { $push: { conversations: { id: forkId, parent: conversationId, at, createdAt: now } }, $set: { updatedAt: now } },
      );
      return { conversationId: forkId };
    });
  },

  /** Change the model every conversation of the thread runs on, from the next request. */
  async 'constellation.durableThreadModel'(threadId, model) {
    check(threadId, Id);
    check(model, Match.Where((value) => {
      check(value, String);
      return value.length > 0 && value.length <= 320;
    }));
    const thread = await ownedThread(this.userId, threadId);
    const agent = await agentFor(this.userId, model);
    this.unblock();
    return answering(async () => {
      for (const conversation of thread.conversations) {
        await Threads.configure(thread._id, conversation.id, { model: agent.model });
      }
      await DurableThreads.updateAsync({ _id: thread._id }, { $set: { model, updatedAt: new Date() } });
      return {};
    });
  },

  /** Delete the thread and everything in it. Pi Durable's entries cannot be deleted one by one; a storage can. */
  async 'constellation.durableThreadRemove'(threadId) {
    check(threadId, Id);
    const thread = await ownedThread(this.userId, threadId);
    this.unblock();
    await answering(() => Threads.destroy(thread._id));
    await DurableThreads.removeAsync({ _id: thread._id });
    return {};
  },
});

Meteor.publish('constellation.durableThreads', function publishDurableThreads() {
  if (!this.userId) return this.ready();
  return DurableThreads.find(
    { userId: this.userId },
    { fields: { title: 1, model: 1, conversations: 1, createdAt: 1, updatedAt: 1 }, sort: { updatedAt: -1 }, limit: THREAD_LIMIT },
  );
});

DurableThreads.deny({ insert: () => true, update: () => true, remove: () => true });

Meteor.startup(async () => {
  await DurableThreads.createIndexAsync({ userId: 1, updatedAt: -1 });
});

// The app limits every `constellation.` method by connection. These two cost
// more than a method call: each `say` may buy a model request, and each
// create opens a storage.
for (const [name, count] of [
  ['constellation.durableThreadSay', 30],
  ['constellation.durableThreadCreate', 10],
]) {
  DDPRateLimiter.addRule({ type: 'method', name, userId: () => true }, count, 60_000);
}
