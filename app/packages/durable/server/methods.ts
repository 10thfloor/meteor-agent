import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { NAMES } from '../common/names';
import { definitionNamed, type Durable, type DurableAction, type DurableContent } from './durable';

// The DDP surface. Every method takes one object, names its definition and
// storage, and is refused unless the definition's `allow` says yes. What a
// client can ask for is deliberately less than the server-side API: user
// input, never raw entry writes; and no agent choices, which come from the
// definition's `agent`.

const MAX_KEY = 256;
const MAX_REQUEST_ID = 200;
/** Text of one input, in UTF-16 code units. Images are bounded by DDP's own message size. */
const MAX_TEXT = 1_000_000;

const Key = Match.Where((value: unknown) => {
  check(value, String);
  return value.length > 0 && value.length <= MAX_KEY;
});
const Id = Match.Where((value: unknown) => {
  check(value, Match.Integer);
  return value > 0;
});
const RequestId = Match.Where((value: unknown) => {
  check(value, String);
  return value.length > 0 && value.length <= MAX_REQUEST_ID;
});
const Text = Match.Where((value: unknown) => {
  check(value, String);
  return value.length <= MAX_TEXT;
});
const Part = Match.Where((value: any) => {
  check(value, Match.OneOf(
    { type: Match.Where((type: unknown) => type === 'text'), text: Text },
    { type: Match.Where((type: unknown) => type === 'image'), data: String, mimeType: String },
  ));
  return true;
});
const Content = Match.OneOf(Text, [Part]);

/** The same refusal for a definition that does not exist and one that says no: neither is a client's to probe. */
async function authorize(
  invocation: { userId: string | null },
  name: string,
  action: DurableAction,
  target: { key: string; conversationId?: number },
): Promise<Durable> {
  const definition = definitionNamed(name);
  if (definition === undefined || !(await definition.allows(invocation.userId ?? null, action, target))) {
    throw new Meteor.Error('not-authorized', 'Not authorized');
  }
  return definition;
}

/** Errors a client can act on keep their names; everything else stays the server's business. */
async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error: any) {
    if (error instanceof Meteor.Error) throw error;
    switch (error?.name) {
      case 'ConversationNotFound':
        throw new Meteor.Error('conversation-not-found', 'No such conversation');
      case 'ConversationBusy':
        throw new Meteor.Error('conversation-busy', 'The conversation is busy');
      case 'RequestExpired':
        throw new Meteor.Error('unavailable', 'No server took the request in time; try again');
      default:
        throw error;
    }
  }
}

export function registerMethods(): void {
  Meteor.methods({
    async [NAMES.mRoot](params: { host: string; key: string }) {
      check(params, { host: String, key: Key });
      const userId = this.userId ?? null;
      const definition = await authorize(this, params.host, 'root', { key: params.key });
      this.unblock();
      return answering(async () => ({
        conversationId: await definition.root(params.key, await definition.agentFor({ key: params.key, userId, action: 'root' })),
      }));
    },

    async [NAMES.mCreate](params: { host: string; key: string }) {
      check(params, { host: String, key: Key });
      const userId = this.userId ?? null;
      const definition = await authorize(this, params.host, 'create', { key: params.key });
      this.unblock();
      return answering(async () => ({
        conversationId: await definition.create(params.key, await definition.agentFor({ key: params.key, userId, action: 'create' })),
      }));
    },

    async [NAMES.mFork](params: { host: string; key: string; conversationId: number; at: number }) {
      check(params, { host: String, key: Key, conversationId: Id, at: Id });
      const { key, conversationId, at } = params;
      const userId = this.userId ?? null;
      const definition = await authorize(this, params.host, 'fork', { key, conversationId });
      this.unblock();
      return answering(async () => ({
        conversationId: await definition.fork(key, conversationId, at, await definition.agentFor({ key, userId, action: 'fork' })),
      }));
    },

    async [NAMES.mSubmit](params: {
      host: string; key: string; conversationId: number; content: DurableContent;
      whenBusy?: 'steer' | 'followUp' | 'reject'; requestId?: string;
    }) {
      check(params, {
        host: String,
        key: Key,
        conversationId: Id,
        content: Content,
        whenBusy: Match.Maybe(Match.OneOf('steer', 'followUp', 'reject')),
        requestId: Match.Maybe(RequestId),
      });
      const { key, conversationId, content, whenBusy, requestId } = params;
      const definition = await authorize(this, params.host, 'submit', { key, conversationId });
      this.unblock();
      return answering(() => definition.submit(key, conversationId, {
        type: 'input',
        content,
        ...(whenBusy == null ? {} : { whenBusy }),
        ...(requestId == null ? {} : { requestId }),
      }));
    },

    async [NAMES.mAbort](params: { host: string; key: string; conversationId: number }) {
      check(params, { host: String, key: Key, conversationId: Id });
      const { key, conversationId } = params;
      const definition = await authorize(this, params.host, 'abort', { key, conversationId });
      this.unblock();
      return answering(() => definition.abort(key, conversationId));
    },

    async [NAMES.mWithdraw](params: { host: string; key: string; conversationId: number; submissionId: number }) {
      check(params, { host: String, key: Key, conversationId: Id, submissionId: Id });
      const { key, conversationId, submissionId } = params;
      const definition = await authorize(this, params.host, 'withdraw', { key, conversationId });
      this.unblock();
      // Scoped to the conversation the caller was authorized for: a submission of another one is "not found".
      return answering(async () => ({ result: await definition.withdraw(key, submissionId, conversationId) }));
    },

    async [NAMES.mReset](params: { host: string; key: string; conversationId: number; handoff?: string }) {
      check(params, { host: String, key: Key, conversationId: Id, handoff: Match.Maybe(Text) });
      const { key, conversationId, handoff } = params;
      const definition = await authorize(this, params.host, 'reset', { key, conversationId });
      this.unblock();
      return answering(async () => {
        await definition.reset(key, conversationId, handoff ?? undefined);
        return {};
      });
    },

    async [NAMES.mCompact](params: { host: string; key: string; conversationId: number; instructions?: string }) {
      check(params, { host: String, key: Key, conversationId: Id, instructions: Match.Maybe(Text) });
      const { key, conversationId, instructions } = params;
      const definition = await authorize(this, params.host, 'compact', { key, conversationId });
      this.unblock();
      return answering(async () => ({ taskId: await definition.compact(key, conversationId, instructions ?? undefined) }));
    },
  });
}

/** One entry of `Meteor.settings.packages['10thfloor:durable'].rateLimit`. */
interface RateLimitEntry {
  count: number;
  intervalMs: number;
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `10thfloor:durable: settings.rateLimit.${field} must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
}

/** Buckets by (userId, connectionId) so anonymous callers are isolated, plus one per signed-in user. */
function addRuleFor(name: string, entry: RateLimitEntry, label: string): number {
  assertPositiveInteger(entry.count, `${label}.count`);
  assertPositiveInteger(entry.intervalMs, `${label}.intervalMs`);
  DDPRateLimiter.addRule(
    { type: 'method', name, userId: () => true, connectionId: () => true },
    entry.count,
    entry.intervalMs,
  );
  DDPRateLimiter.addRule(
    { type: 'method', name, userId: (id: string | null) => id != null },
    entry.count,
    entry.intervalMs,
  );
  return 2;
}

/**
 * Register DDP rate-limit rules from the package settings and return how many
 * were added. Missing settings add none; a malformed entry throws.
 *
 * - `submits`: `durable.submit`. Each one may buy a model request.
 * - `creates`: `durable.root`, `durable.create`, `durable.fork`.
 * - `controls`: `durable.abort`, `durable.withdraw`, `durable.reset`, `durable.compact`.
 */
export function applyRateLimits(settings: unknown): number {
  const rateLimit = (settings as { rateLimit?: Record<string, RateLimitEntry> } | null | undefined)?.rateLimit;
  if (!rateLimit) return 0;
  let added = 0;
  if (rateLimit.submits) added += addRuleFor(NAMES.mSubmit, rateLimit.submits, 'submits');
  if (rateLimit.creates) {
    for (const name of [NAMES.mRoot, NAMES.mCreate, NAMES.mFork]) added += addRuleFor(name, rateLimit.creates, 'creates');
  }
  if (rateLimit.controls) {
    for (const name of [NAMES.mAbort, NAMES.mWithdraw, NAMES.mReset, NAMES.mCompact]) {
      added += addRuleFor(name, rateLimit.controls, 'controls');
    }
  }
  return added;
}
