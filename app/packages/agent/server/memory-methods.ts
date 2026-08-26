import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { NAMES } from '../common/names';
import { MEMORY_SCOPES, type MemoryScope } from '../common/types';
import type { ResolvedMemory } from '../common/types';
import { forgetMemory, saveMemory, searchMemory } from './memory';

/* User's DDP memory surface — narrower than the model's (decision 7a).
 * App-scope writes and deletes refused outright; shared knowledge is
 * written only by an approved model proposal. */

/** Latched: Meteor.methods throws on duplicate names, and hot reload
 *  re-enters defineAgent. */
let registered = false;

/** Test seam: assert the latch without a second process. */
export function _memoryMethodsRegistered(): boolean { return registered; }

/** Which memory config governs a DDP call. Injected by `registry` to
 *  avoid a circular import. */
export type GoverningConfig = () => { config?: ResolvedMemory; agent: string };

let governingConfig: GoverningConfig = () => ({ agent: '' });

export function ensureMemoryMethods(resolve: GoverningConfig): void {
  governingConfig = resolve;
  if (registered) return;
  registered = true;

  Meteor.methods({
    async [NAMES.mMemorySave](args: unknown) {
      check(args, Match.Any);
      const a = (args ?? {}) as { text?: unknown; scope?: unknown; key?: unknown; pinned?: unknown };
      const userId = (this as Meteor.MethodThisType).userId ?? null;
      if (userId === null) {
        throw new Meteor.Error('not-authorized', 'Sign in to save a memory.');
      }
      const scope = (a.scope ?? 'user') as MemoryScope;
      if (!MEMORY_SCOPES.includes(scope)) {
        throw new Meteor.Error('invalid-args', `Unknown memory scope "${String(a.scope)}".`);
      }
      // Decision 7a — the whole point of this module.
      if (scope === 'app') {
        throw new Meteor.Error(
          'denied-scope',
          'Shared work memory cannot be written from a client; it is proposed by an '
          + 'agent and approved by a person.',
        );
      }
      // Agent-scope rows belong to a specific agent; a client names none.
      if (scope === 'agent') {
        throw new Meteor.Error(
          'denied-scope',
          'Agent-private memory belongs to a specific agent and cannot be written '
          + 'from a client.',
        );
      }
      const { config, agent } = governingConfig();
      if (!config) throw new Meteor.Error('no-memory', 'No agent in this app declares memory.');
      const result = await saveMemory(
        {
          text: String(a.text ?? ''),
          scope,
          ...(typeof a.key === 'string' ? { key: a.key } : {}),
          ...(a.pinned === true ? { pinned: true } : {}),
        },
        { by: `h:${userId}`, userId, agent, config },
      );
      // Translate structured refusal → Meteor.Error for DDP callers.
      if (!result.ok) throw new Meteor.Error(result.error, result.reason);
      return result;
    },

    async [NAMES.mMemorySearch](args: unknown) {
      check(args, Match.Any);
      const a = (args ?? {}) as { query?: unknown; limit?: unknown };
      const userId = (this as Meteor.MethodThisType).userId ?? null;
      if (userId === null) {
        throw new Meteor.Error('not-authorized', 'Sign in to search your memory.');
      }
      const { config, agent } = governingConfig();
      if (!config) throw new Meteor.Error('no-memory', 'No agent in this app declares memory.');
      return searchMemory(String(a.query ?? ''), {
        userId,
        agent,
        config,
        ...(typeof a.limit === 'number' ? { limit: a.limit } : {}),
      });
    },

    async [NAMES.mMemoryForget](args: unknown) {
      check(args, Match.Any);
      const a = (args ?? {}) as { id?: unknown };
      const userId = (this as Meteor.MethodThisType).userId ?? null;
      if (userId === null) {
        throw new Meteor.Error('not-authorized', 'Sign in to forget a memory.');
      }
      const { agent } = governingConfig();
      const result = await forgetMemory(String(a.id ?? ''), {
        userId,
        agent,
        // Decision 7a: never from a client.
        allowApp: false,
      });
      if (!result.ok) throw new Meteor.Error(result.error, result.reason);
      return result;
    },
  });
}
